/**
 * iCal içe aktarma senkronu. Next.js'e ve "server-only"e bağımlı DEĞİLDİR: hem panel (elle senkron)
 * hem cron betiği (dist/ical-sync.js) kullanır.
 *
 * Akış (kaynak başına, birbirinden bağımsız):
 *   1. Kilit: app_ical_claim_sources (kısa transaction, hemen commit) → adres + kilit belirteci.
 *      Aynı kaynakta eşzamanlı ikinci senkron kilidi alamaz.
 *   2. İndirme ve ayrıştırma transaction DIŞINDA (ağ beklerken veritabanı bağlantısı tutulmaz):
 *      SSRF korumalı fetch → parseIcs.
 *   3. Sonuç: app_ical_apply_sync (tek transaction): olaylar UID ile upsert, görülmeyenler YALNIZ
 *      bu kaynakta pasif; hata durumunda olaylara dokunulmaz. Senkron kaydı ve kaynak durumu yazılır.
 * Bir kaynağın hatası diğerlerini durdurmaz. Log'a adres, UID veya etkinlik içeriği yazılmaz.
 */
import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { pgErrorInfo } from "@/db/pg-error";
import { type IcsEvent, parseIcs } from "@/lib/ical";
import { ICAL_LIMITS, type IcalErrorCode, type IcalSyncTrigger } from "@/lib/ical-meta";
import type { Logger } from "@/lib/logger";
import { istanbulToday } from "@/lib/reservation-meta";

import { createIcsFetcher, type IcsFetcher } from "./fetch";

type AnyDb = Database;
type Executor = Pick<AnyDb, "execute">;

export type SyncDeps = {
  fetcher?: IcsFetcher;
  /** Europe/Istanbul bugünü (testlerde sabitlenir). */
  today?: () => string;
  log?: Pick<Logger, "info" | "warn" | "error">;
};

export type Claim = { sourceId: string; url: string; lockToken: string };

export type ClaimOutcome = "claimed" | "locked" | "too_soon" | "inactive" | "not_found";

export type SyncResult =
  | {
      outcome: "ok";
      total: number;
      added: number;
      updated: number;
      deactivated: number;
      conflicts: number;
    }
  | { outcome: "error"; code: IcalErrorCode }
  | { outcome: "lock_lost" };

type ClaimRow = {
  source_id: string;
  url: string | null;
  lock_token: string | null;
  outcome: ClaimOutcome;
};

/** Elle senkron için tek kaynağın kilidi (çağıran, kaynağın kendi işletmesine ait olduğunu RLS ile doğrulamış olmalı). */
export async function claimSource(
  tx: Executor,
  sourceId: string,
): Promise<{ outcome: ClaimOutcome; claim?: Claim }> {
  const res = await tx.execute<ClaimRow>(
    sql`select * from app_ical_claim_sources(${sourceId}::uuid, 'manual', 1)`,
  );
  const row = res.rows[0];
  if (!row) return { outcome: "not_found" };
  if (row.outcome !== "claimed" || !row.url || !row.lock_token) return { outcome: row.outcome };
  return {
    outcome: "claimed",
    claim: { sourceId: row.source_id, url: row.url, lockToken: row.lock_token },
  };
}

async function claimDue(db: AnyDb, limit: number): Promise<Claim[]> {
  const res = await db.execute<ClaimRow>(
    sql`select * from app_ical_claim_sources(null, 'cron', ${limit})`,
  );
  return res.rows.flatMap((r) =>
    r.outcome === "claimed" && r.url && r.lock_token
      ? [{ sourceId: r.source_id, url: r.url, lockToken: r.lock_token }]
      : [],
  );
}

type ApplyRow = {
  outcome: "ok" | "error";
  events_total: number;
  events_added: number;
  events_updated: number;
  events_deactivated: number;
  conflict_count: number;
};

async function apply(
  db: AnyDb,
  claim: Claim,
  trigger: IcalSyncTrigger,
  startedAt: Date,
  events: IcsEvent[] | null,
  errorCode: IcalErrorCode | null,
): Promise<SyncResult> {
  const payload = events
    ? JSON.stringify(events.map((e) => ({ uid: e.uid, start_date: e.start, end_date: e.end })))
    : null;
  try {
    const res = await db.execute<ApplyRow>(sql`
      select * from app_ical_apply_sync(${claim.sourceId}::uuid, ${claim.lockToken}::uuid,
        ${trigger}, ${startedAt.toISOString()}::timestamptz, ${payload}::jsonb, ${errorCode})`);
    const row = res.rows[0];
    if (!row) return { outcome: "error", code: "internal" };
    if (row.outcome === "error") return { outcome: "error", code: errorCode ?? "internal" };
    return {
      outcome: "ok",
      total: row.events_total,
      added: row.events_added,
      updated: row.events_updated,
      deactivated: row.events_deactivated,
      conflicts: row.conflict_count,
    };
  } catch (err) {
    if (pgErrorInfo(err).message === "ical_lock_lost") return { outcome: "lock_lost" };
    throw err;
  }
}

/** Kilidi alınmış tek kaynağı senkron eder (indir → ayrıştır → uygula). */
export async function syncClaimed(
  db: AnyDb,
  claim: Claim,
  trigger: IcalSyncTrigger,
  deps: SyncDeps = {},
): Promise<SyncResult> {
  const fetcher = deps.fetcher ?? createIcsFetcher();
  const today = deps.today?.() ?? istanbulToday();
  const startedAt = new Date();
  let events: IcsEvent[] | null = null;
  let errorCode: IcalErrorCode | null = null;
  try {
    const fetched = await fetcher(claim.url);
    if (!fetched.ok) {
      errorCode = fetched.code;
    } else {
      const parsed = await parseIcs(fetched.text, today);
      if (parsed.ok) events = parsed.events;
      else errorCode = parsed.error;
    }
  } catch {
    errorCode = "internal";
  }
  let result: SyncResult;
  try {
    result = await apply(db, claim, trigger, startedAt, events, errorCode);
  } catch (err) {
    // Uygulama hatası (ör. veritabanı): kaydı hata olarak işaretlemeyi bir kez daha dene.
    deps.log?.error("ical_sync_apply_failed", { source: claim.sourceId, err });
    if (errorCode) throw err;
    result = await apply(db, claim, trigger, startedAt, null, "internal");
  }
  deps.log?.info("ical_sync_finished", {
    source: claim.sourceId,
    trigger,
    outcome: result.outcome,
    ...(result.outcome === "ok"
      ? {
          total: result.total,
          added: result.added,
          deactivated: result.deactivated,
          conflicts: result.conflicts,
        }
      : result.outcome === "error"
        ? { code: result.code }
        : {}),
  });
  return result;
}

export type DueSyncSummary = {
  processed: number;
  ok: number;
  failed: number;
  lockLost: number;
};

/**
 * Cron: vadesi gelen kaynakları küçük partilerle (eşzamanlılık 4) senkron eder. Bir partide
 * kilit alınamayan kaynak bir sonraki çalıştırmaya kalır. Süre bütçesi aşılınca durur.
 */
export async function runDueSync(
  db: AnyDb,
  deps: SyncDeps & { maxSources?: number; budgetMs?: number } = {},
): Promise<DueSyncSummary> {
  const summary: DueSyncSummary = { processed: 0, ok: 0, failed: 0, lockLost: 0 };
  const maxSources = deps.maxSources ?? 200;
  const deadline = Date.now() + (deps.budgetMs ?? 4 * 60_000);
  while (summary.processed < maxSources && Date.now() < deadline) {
    const batch = await claimDue(
      db,
      Math.min(ICAL_LIMITS.concurrency, maxSources - summary.processed),
    );
    if (batch.length === 0) break;
    const results = await Promise.allSettled(batch.map((c) => syncClaimed(db, c, "cron", deps)));
    for (const r of results) {
      summary.processed++;
      if (r.status === "rejected") {
        summary.failed++;
        deps.log?.error("ical_sync_source_failed", { err: r.reason });
      } else if (r.value.outcome === "ok") summary.ok++;
      else if (r.value.outcome === "lock_lost") summary.lockLost++;
      else summary.failed++;
    }
  }
  return summary;
}
