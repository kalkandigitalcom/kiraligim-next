/**
 * WhatsApp Asistanı — A2c: takvim worker'ı. Next.js'e ve "server-only"e bağımlı DEĞİLDİR
 * (dist/wa-calendar.js, Coolify Scheduled Task; iCal senkronuyla aynı model).
 *
 * Akış (iCal kilitleme deseni):
 *   1. app_wa_expire_proposals: süresi geçen bekleyen öneriler "expired".
 *   2. İş alma: app_wa_claim_messages (kısa çağrı, hemen commit) → mesaj + kilit belirteci.
 *      İlk çağrı worker'ı atomik olarak etkinleştirir; o ana kadarki mesajlar öneri üretmez.
 *   3. Transaction DIŞINDA: ayrıştırma (parser v2, bugün = mesajın gönderildiği gün,
 *      Europe/Istanbul) → villa çözümü (resolveProposal, işletmenin aktif villaları) → çakışma
 *      özeti (app_wa_busy, yalnız okuma) → öğeler (buildStoreItem).
 *   4. Tek atomik yazım: app_wa_store_proposals. Veritabanı kilidi, grubu, villayı ve gönderen
 *      yetkisini yazım anında yeniden denetler; kilit kaybında hiçbir şey yazılmaz.
 *
 *   5. (A2e) Otomatik kapatma: öğe autoCloseCandidate kuralını geçiyorsa (tek öğe, sahibin açık,
 *      net tarihli, çakışmasız kapatma talimatı, grubun villası) gönderen kullanıcı kilitliyken
 *      bulunur (app_wa_message_sender) ve öneri kaydedildikten SONRA deps.autoClose çağrılır.
 *      Blok yalnız oradan, sahibin oturum bağlamında ve rezervasyon servisiyle oluşur; başarısızlıkta
 *      öneri panelde onay bekler. autoClose verilmezse (testler) yalnız öneri oluşur.
 *
 *   6. (A2f) Tepki: mesaj sonuçlandıktan SONRA decideReaction (merkezi karar) ile tek tepki seçilir ve
 *      app_wa_queue_reaction ile kuyruğa yazılır (veritabanı kararı yeniden doğrular; mesaj başına
 *      tek tepki). Ağ geçidi gönderir. Kuyruğa yazılamazsa yalnız log: takvim ve öneri etkilenmez.
 *
 * GÜVENLİK: worker kendisi rezervasyon veya harici takvim tablosuna yazan hiçbir kodu import
 * etmez (eslint sınırı); takvime giden TEK yol enjekte edilen AutoCloser'dır (cron.ts bağlar).
 * Kullanıcısız bağlantı öneriyi onaylayamaz (veritabanı).
 * Log'a mesaj metni, villa adı, alıntı, telefon veya numara özeti YAZILMAZ; yalnız kimlik ve sayaç.
 * Veritabanı hata nesneleri (sorgu parametreleri mesaj içerebilir) log'a olduğu gibi verilmez.
 */
import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { pgErrorInfo } from "@/db/pg-error";
import type { Logger } from "@/lib/logger";
import { istanbulToday } from "@/lib/reservation-meta";
import {
  type WaCalendarItem,
  type WaSenderRole,
  parseCalendarMessage,
  WA_SENDER_ROLES,
} from "@/lib/wa-calendar-parse";
import {
  WA_PROPOSAL_LIMITS as PL,
  WA_WORKER_LIMITS as WL,
  type WaReactionKind,
  type WaWorkerError,
} from "@/lib/whatsapp-meta";

import type { AutoCloser } from "../auto-close";
import { autoCloseCandidate } from "./auto-close-rule";
import { decideReaction } from "./reaction";
import { type BusyRow, buildStoreItem, busyRange, type StoreItem } from "./proposal";
import { type ResolverVilla, resolveProposal } from "./resolve";

type Executor = Pick<Database, "execute">;
type Log = Pick<Logger, "info" | "warn" | "error">;

export type WorkerDeps = {
  /** Şimdiki zaman (testlerde sabitlenebilir); mesaj yaşı denetimi için. */
  now?: () => Date;
  log?: Log;
  batchSize?: number;
  budgetMs?: number;
  maxMessages?: number;
  /** Test kancası: öğeler hazırlandıktan sonra, yazımdan hemen önce. */
  beforeStore?: (claim: ClaimedMessage) => Promise<void>;
  /** A2e: sahibin açık kapatma talimatını takvime işleyen servis (verilmezse yalnız öneri). */
  autoClose?: AutoCloser;
};

export type ClaimedMessage = {
  messageId: string;
  lockToken: string;
  workspaceId: string;
  groupId: string;
  groupPropertyId: string | null;
  body: string;
  sentAt: Date;
  senderRole: WaSenderRole | null;
  attempts: number;
};

export type ProcessOutcome =
  | {
      outcome: "stored";
      proposals: number;
      autoClose?: "applied" | "failed";
      /** Kuyruğa yazılan tepki (yazılmadıysa veya tepki yoksa null). */
      reaction?: WaReactionKind | null;
    }
  | { outcome: "lock_lost" }
  | { outcome: "retry" | "failed"; code: WaWorkerError };

export type WorkerSummary = {
  expired: number;
  claimed: number;
  stored: number;
  proposals: number;
  retried: number;
  failed: number;
  lockLost: number;
  autoClosed: number;
  autoCloseFailed: number;
  reactions: number;
};

/** Log'a güvenle yazılabilecek hata özeti: SQLSTATE ve yalnız bizim kısa kodlarımız. */
export function safeError(err: unknown): { code?: string; reason?: string } {
  const info = pgErrorInfo(err);
  const out: { code?: string; reason?: string } = {};
  if (info.code) out.code = info.code;
  if (info.message && /^wa_[a-z_]{1,40}$/.test(info.message)) out.reason = info.message;
  if (!info.code && err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name))
    out.reason = err.name;
  return out;
}

const reasonOf = (err: unknown) => pgErrorInfo(err).message;

type ClaimRow = {
  message_id: string;
  lock_token: string;
  workspace_id: string;
  group_id: string;
  group_property_id: string | null;
  body: string;
  sent_at: Date | string;
  sender_role: string | null;
  attempts: number;
};

export async function claimMessages(db: Executor, limit: number): Promise<ClaimedMessage[]> {
  const res = await db.execute<ClaimRow>(
    sql`select message_id, lock_token, workspace_id, group_id, group_property_id, body, sent_at,
               sender_role, attempts
          from public.app_wa_claim_messages(${limit}::integer)`,
  );
  return res.rows.map((r) => ({
    messageId: r.message_id,
    lockToken: r.lock_token,
    workspaceId: r.workspace_id,
    groupId: r.group_id,
    groupPropertyId: r.group_property_id,
    body: r.body,
    sentAt: r.sent_at instanceof Date ? r.sent_at : new Date(r.sent_at),
    senderRole: (WA_SENDER_ROLES as readonly string[]).includes(r.sender_role ?? "")
      ? (r.sender_role as WaSenderRole)
      : null,
    attempts: Number(r.attempts),
  }));
}

async function villasOf(db: Executor, c: ClaimedMessage): Promise<ResolverVilla[]> {
  const res = await db.execute<{ property_id: string; name: string }>(
    sql`select property_id, name from public.app_wa_message_context(${c.messageId}::uuid, ${c.lockToken}::uuid)`,
  );
  // İşletme kimliği mesajdan (iş alma) gelir; fonksiyon yalnız o işletmenin villalarını döndürür.
  return res.rows.map((r) => ({ id: r.property_id, workspaceId: c.workspaceId, name: r.name }));
}

async function busyOf(
  db: Executor,
  c: ClaimedMessage,
  propertyId: string,
  range: { from: string; to: string },
): Promise<BusyRow[]> {
  const res = await db.execute<{
    kind: string;
    record_id: string;
    check_in: string;
    check_out: string;
    status: string;
  }>(
    sql`select kind, record_id, check_in::text as check_in, check_out::text as check_out, status
          from public.app_wa_busy(${c.messageId}::uuid, ${c.lockToken}::uuid, ${propertyId}::uuid,
                                  ${range.from}::date, ${range.to}::date)`,
  );
  return res.rows.map((r) => ({
    kind: r.kind,
    recordId: r.record_id,
    checkIn: r.check_in,
    checkOut: r.check_out,
    status: r.status,
  }));
}

/** Kilitli mesajın gönderen kullanıcısı ve rolü (numara döndürülmez). */
async function senderOf(
  db: Executor,
  c: ClaimedMessage,
): Promise<{ userId: string; role: string } | null> {
  const res = await db.execute<{ user_id: string; role: string }>(
    sql`select user_id, role from public.app_wa_message_sender(${c.messageId}::uuid, ${c.lockToken}::uuid)`,
  );
  const r = res.rows[0];
  return r ? { userId: r.user_id, role: r.role } : null;
}

async function store(db: Executor, c: ClaimedMessage, items: StoreItem[]): Promise<number> {
  const res = await db.execute<{ n: number }>(
    sql`select public.app_wa_store_proposals(${c.messageId}::uuid, ${c.lockToken}::uuid,
                                             ${JSON.stringify(items)}::jsonb) as n`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

async function fail(db: Executor, c: ClaimedMessage, code: WaWorkerError): Promise<ProcessOutcome> {
  const res = await db.execute<{ r: string }>(
    sql`select public.app_wa_fail_message(${c.messageId}::uuid, ${c.lockToken}::uuid, ${code}) as r`,
  );
  const r = res.rows[0]?.r;
  if (r === "lost") return { outcome: "lock_lost" };
  return { outcome: r === "failed" ? "failed" : "retry", code };
}

/** Mesajın öğelerini ayrıştırır: bugün = gönderildiği gün (Europe/Istanbul); yeniden denemede aynı. */
export function parseForMessage(body: string, sentAt: Date): WaCalendarItem[] {
  return parseCalendarMessage(body, istanbulToday(sentAt)).items.slice(0, PL.itemsPerMessage);
}

/** Kilidi alınmış tek mesajı işler. Hatalar mesaja kısa kodla yazılır; asla yeniden fırlatılmaz. */
export async function processClaimed(
  db: Executor,
  c: ClaimedMessage,
  deps: WorkerDeps = {},
): Promise<ProcessOutcome> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log;
  const step = async <T>(code: WaWorkerError, fn: () => Promise<T> | T) => {
    try {
      return { ok: true as const, value: await fn() };
    } catch (err) {
      if (reasonOf(err) === "wa_claim_lost")
        return { ok: false as const, out: { outcome: "lock_lost" } as const };
      log?.warn("wa_calendar_step_failed", { message: c.messageId, step: code, ...safeError(err) });
      const reason = reasonOf(err) === "wa_context_changed" ? "context_changed" : code;
      try {
        return { ok: false as const, out: await fail(db, c, reason) };
      } catch (err2) {
        log?.error("wa_calendar_fail_failed", { message: c.messageId, ...safeError(err2) });
        return { ok: false as const, out: { outcome: "retry", code: reason } as ProcessOutcome };
      }
    }
  };

  let items: StoreItem[] = [];
  // Savunma: eski mesaj (veritabanı zaten eler) öneri üretmez.
  const tooOld = now.getTime() - c.sentAt.getTime() > PL.maxMessageAgeDays * 864e5;
  if (!tooOld) {
    const parsed = await step("parse_error", () => parseForMessage(c.body, c.sentAt));
    if (!parsed.ok) return parsed.out;
    if (parsed.value.length > 0) {
      const villas = await step("context_error", () => villasOf(db, c));
      if (!villas.ok) return villas.out;
      const built = await step("busy_error", async () => {
        const out: StoreItem[] = [];
        for (const [i, item] of parsed.value.entries()) {
          const villa = resolveProposal(item, {
            workspaceId: c.workspaceId,
            villas: villas.value,
            groupPropertyId: c.groupPropertyId,
          });
          const range = villa.propertyId ? busyRange(item, WL.busyMaxNights) : null;
          const busy =
            villa.propertyId && range ? await busyOf(db, c, villa.propertyId, range) : null;
          out.push(buildStoreItem({ item, itemNo: i, villa, busy, senderRole: c.senderRole }));
        }
        return out;
      });
      if (!built.ok) return built.out;
      items = built.value;
    }
  }

  // A2e: otomatik kapatma adayı ve gönderen kullanıcı (mesaj hâlâ kilitliyken).
  const candidate = deps.autoClose
    ? autoCloseCandidate(items, { senderRole: c.senderRole, groupPropertyId: c.groupPropertyId })
    : null;
  let owner: string | null = null;
  if (candidate) {
    const sender = await step("context_error", () => senderOf(db, c));
    if (!sender.ok) return sender.out;
    owner = sender.value?.role === "owner" ? sender.value.userId : null;
  }

  await deps.beforeStore?.(c);
  const stored = await step("store_error", () => store(db, c, items));
  if (!stored.ok) return stored.out;
  if (!candidate || !owner || !deps.autoClose || stored.value === 0) {
    const reaction = await queueReaction(db, c, items, stored.value, undefined, log);
    return { outcome: "stored", proposals: stored.value, reaction };
  }

  // Öneri kaydedildi ve mesaj işlendi; otomatik kapatma başarısız olursa öneri panelde bekler.
  let auto: "applied" | "failed" = "failed";
  try {
    const r = await deps.autoClose({
      workspaceId: c.workspaceId,
      userId: owner,
      messageId: c.messageId,
      itemNo: candidate.item_no,
      propertyId: candidate.property_id!,
      checkIn: candidate.check_in!,
      checkOut: candidate.check_out!,
    });
    auto = r.outcome;
    log?.info("wa_calendar_auto_close", {
      message: c.messageId,
      outcome: r.outcome,
      ...(r.outcome === "failed" ? { reason: r.reason } : {}),
    });
  } catch (err) {
    log?.error("wa_calendar_auto_close_error", { message: c.messageId, ...safeError(err) });
  }
  const reaction = await queueReaction(db, c, items, stored.value, auto, log);
  return { outcome: "stored", proposals: stored.value, autoClose: auto, reaction };
}

/**
 * Mesajın tepkisini kuyruğa yazar (A2f). Hiçbir zaman fırlatmaz: tepki yazılamazsa takvim işlemi ve
 * öneriler aynen kalır; yalnız içeriksiz log. Veritabanı kararı reddederse ("rejected") tepki yok.
 */
async function queueReaction(
  db: Executor,
  c: ClaimedMessage,
  items: StoreItem[],
  stored: number,
  autoClose: "applied" | "failed" | undefined,
  log: Log | undefined,
): Promise<WaReactionKind | null> {
  const kind = decideReaction({ senderRole: c.senderRole, items, stored, autoClose });
  if (!kind) return null;
  try {
    const res = await db.execute<{ r: string }>(
      sql`select public.app_wa_queue_reaction(${c.messageId}::uuid, ${kind}) as r`,
    );
    const r = res.rows[0]?.r;
    if (r !== "queued")
      log?.warn("wa_calendar_reaction_skipped", {
        message: c.messageId,
        kind,
        result: r ?? "none",
      });
    return r === "queued" ? kind : null;
  } catch (err) {
    log?.warn("wa_calendar_reaction_failed", { message: c.messageId, kind, ...safeError(err) });
    return null;
  }
}

/**
 * Bir çalıştırma: süresi geçenleri kapatır, sonra bütçe dolana kadar küçük partilerle iş alır ve
 * mesajları sırayla işler. İş alma veya süre kapatma hatası fırlatılır (cron çıkış kodu 1).
 */
export async function runCalendarWorker(
  db: Executor,
  deps: WorkerDeps = {},
): Promise<WorkerSummary> {
  const summary: WorkerSummary = {
    expired: 0,
    claimed: 0,
    stored: 0,
    proposals: 0,
    retried: 0,
    failed: 0,
    lockLost: 0,
    autoClosed: 0,
    autoCloseFailed: 0,
    reactions: 0,
  };
  const batch = Math.min(Math.max(1, deps.batchSize ?? WL.batchSize), PL.claimBatchMax);
  const maxMessages = deps.maxMessages ?? WL.maxMessagesPerRun;
  const deadline = Date.now() + (deps.budgetMs ?? WL.budgetMs);

  const exp = await db.execute<{ n: number }>(sql`select public.app_wa_expire_proposals() as n`);
  summary.expired = Number(exp.rows[0]?.n ?? 0);

  while (summary.claimed < maxMessages && Date.now() < deadline) {
    const claims = await claimMessages(db, Math.min(batch, maxMessages - summary.claimed));
    if (claims.length === 0) break;
    for (const c of claims) {
      summary.claimed++;
      const r = await processClaimed(db, c, deps);
      if (r.outcome === "stored") {
        summary.stored++;
        summary.proposals += r.proposals;
        if (r.reaction) summary.reactions++;
        if (r.autoClose === "applied") summary.autoClosed++;
        else if (r.autoClose === "failed") summary.autoCloseFailed++;
      } else if (r.outcome === "lock_lost") summary.lockLost++;
      else if (r.outcome === "failed") summary.failed++;
      else summary.retried++;
      deps.log?.info("wa_calendar_message", {
        message: c.messageId,
        attempts: c.attempts,
        outcome: r.outcome,
        ...(r.outcome === "stored" ? { proposals: r.proposals } : {}),
        ...(r.outcome === "retry" || r.outcome === "failed" ? { code: r.code } : {}),
      });
    }
  }
  return summary;
}
