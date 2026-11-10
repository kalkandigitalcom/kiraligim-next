import "server-only";

import { sql } from "drizzle-orm";

import type { TenantContext, Tx } from "@/db/tenant";
import { AppError, conflict, forbidden, notFound, validationError } from "@/lib/errors";
import { type ReservationStatus, istanbulToday } from "@/lib/reservation-meta";
import { parseGuestCount, type WaGuestCount } from "@/lib/wa-calendar-parse";
import type { WaProposalStatus } from "@/lib/whatsapp-meta";
import { recordAudit } from "@/server/audit/record";
import { type ExternalConflict, findExternalConflicts } from "@/server/ical/service";
import { isUuid } from "@/server/properties/service";
import { type Conflict, createReservation, findConflicts } from "@/server/reservations/service";

/**
 * WhatsApp Asistanı — A2d: takvim önerilerinin panelde incelenmesi ve KARARI.
 *
 * Ham WhatsApp mesajı hiçbir zaman doğrudan takvime yazılmaz: worker yalnız öneri üretir
 * (wa_calendar_proposals). Rezervasyon veya blok YALNIZ burada, oturumdaki owner/manager'ın
 * onayıyla ve mevcut rezervasyon servisiyle (createReservation: doğrulama, kapasite, pasif mülk,
 * çakışma kısıtı) TEK transaction'da oluşur; öneri aynı transaction'da "applied" olur. Herhangi
 * bir adım başarısız olursa (çakışma, eski sürüm, yetki) hiçbir şey yazılmaz.
 *
 * Güvenlik (veritabanında da):
 *  - RLS: öneriler yalnız kendi işletmesinde owner/manager'a görünür ve güncellenebilir;
 *  - durum makinesi tetikleyicisi: karar yalnız oturumdaki owner/manager adına (decided_by),
 *    karar verilmiş öneri değişmez, her değişiklikte sürüm artar (iyimser kilit);
 *  - rezervasyon.origin_proposal_id bileşik yabancı anahtarla yalnız bu işletmenin önerisine bağlanır.
 *
 * Bu aşamada panelden uygulanabilen eylemler: rezervasyon (reserve) ve kapatma (close → blok).
 * Açma ve iptal önerileri incelenir ve reddedilebilir; takvimde elle yapılır (hedef kayıt seçimi
 * sonraki aşama).
 */

export const WA_APPLICABLE_ACTIONS = ["reserve", "close"] as const;
type ApplicableAction = (typeof WA_APPLICABLE_ACTIONS)[number];

export const canDecideProposals = (ctx: TenantContext) =>
  ctx.role === "owner" || ctx.role === "manager";

export type ProposalListFilter = "pending" | "decided";

export type WaProposalView = {
  id: string;
  version: number;
  status: WaProposalStatus;
  action: "close" | "reserve" | "open" | "cancel" | null;
  propertyId: string | null;
  propertyName: string | null;
  villaNameRaw: string | null;
  villaResolution: "named" | "single" | "ambiguous" | "none";
  candidates: { id: string; name: string }[];
  checkIn: string | null;
  checkOut: string | null;
  reservationStatus: "confirmed" | "pending" | null;
  flags: string[];
  reviewReasons: string[];
  score: number;
  band: "high" | "medium" | "low";
  senderRole: "owner" | "manager" | "staff";
  groupId: string;
  groupSubject: string | null;
  sentAt: Date;
  createdAt: Date;
  excerpt: string;
  /** Mesajdan ön doldurma için kişi sayısı (yalnız öneri; yönetici düzeltir). */
  guests: WaGuestCount;
  decidedAt: Date | null;
  decisionNote: string | null;
  appliedReservationIds: string[];
};

type Row = {
  id: string;
  version: number;
  status: WaProposalStatus;
  action: WaProposalView["action"];
  property_id: string | null;
  property_name: string | null;
  villa_name_raw: string | null;
  villa_resolution: WaProposalView["villaResolution"];
  candidate_property_ids: string[];
  check_in: string | null;
  check_out: string | null;
  reservation_status: WaProposalView["reservationStatus"];
  flags: string[];
  review_reasons: string[];
  score: number;
  band: WaProposalView["band"];
  sender_role: WaProposalView["senderRole"];
  group_id: string;
  group_subject: string | null;
  sent_at: Date;
  created_at: Date;
  message_excerpt: string;
  decided_at: Date | null;
  decision_note: string | null;
  applied_reservation_ids: string[];
};

const SELECT = sql`
  select pr.id, pr.version, pr.status, pr.action, pr.property_id, p.name as property_name,
         pr.villa_name_raw, pr.villa_resolution, pr.candidate_property_ids,
         to_char(pr.check_in, 'YYYY-MM-DD') as check_in,
         to_char(pr.check_out, 'YYYY-MM-DD') as check_out,
         pr.reservation_status, pr.flags, pr.review_reasons, pr.score, pr.band, pr.sender_role,
         pr.group_id, g.subject as group_subject, pr.sent_at, pr.created_at, pr.message_excerpt,
         pr.decided_at, pr.decision_note, pr.applied_reservation_ids
    from wa_calendar_proposals pr
    left join properties p on p.id = pr.property_id and p.workspace_id = pr.workspace_id
    left join wa_groups g on g.id = pr.group_id`;

async function candidateNames(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  const valid = ids.filter(isUuid);
  if (valid.length === 0) return new Map();
  const res = await tx.execute<{ id: string; name: string }>(sql`
    select id, name from properties
     where workspace_id = app_current_workspace_id()
       and id in (${sql.join(
         valid.map((v) => sql`${v}::uuid`),
         sql`, `,
       )})`);
  return new Map(res.rows.map((r) => [r.id, r.name]));
}

function toView(r: Row, names: Map<string, string>): WaProposalView {
  return {
    id: r.id,
    version: Number(r.version),
    status: r.status,
    action: r.action,
    propertyId: r.property_id,
    propertyName: r.property_name,
    villaNameRaw: r.villa_name_raw,
    villaResolution: r.villa_resolution,
    candidates: (r.candidate_property_ids ?? []).map((id) => ({
      id,
      name: names.get(id) ?? "(villa)",
    })),
    checkIn: r.check_in,
    checkOut: r.check_out,
    reservationStatus: r.reservation_status,
    flags: r.flags ?? [],
    reviewReasons: r.review_reasons ?? [],
    score: Number(r.score),
    band: r.band,
    senderRole: r.sender_role,
    groupId: r.group_id,
    groupSubject: r.group_subject,
    sentAt: new Date(r.sent_at),
    createdAt: new Date(r.created_at),
    excerpt: r.message_excerpt,
    guests: parseGuestCount(r.message_excerpt),
    decidedAt: r.decided_at ? new Date(r.decided_at) : null,
    decisionNote: r.decision_note,
    appliedReservationIds: r.applied_reservation_ids ?? [],
  };
}

/** Öneri listesi (owner/manager). Bekleyenler en eski gönderim önce; kararlar en yeni önce. */
export async function listProposals(
  tx: Tx,
  ctx: TenantContext,
  filter: ProposalListFilter = "pending",
  limit = 100,
): Promise<WaProposalView[]> {
  if (!canDecideProposals(ctx)) throw forbidden();
  const res = await tx.execute<Row>(sql`
    ${SELECT}
    where pr.workspace_id = app_current_workspace_id()
      and ${filter === "pending" ? sql`pr.status = 'pending'` : sql`pr.status in ('applied', 'rejected')`}
    order by ${filter === "pending" ? sql`pr.sent_at asc, pr.item_no asc` : sql`pr.decided_at desc`}
    limit ${Math.min(Math.max(limit, 1), 200)}`);
  const names = await candidateNames(
    tx,
    res.rows.flatMap((r) => r.candidate_property_ids ?? []),
  );
  return res.rows.map((r) => toView(r, names));
}

export async function countPendingProposals(tx: Tx, ctx: TenantContext): Promise<number> {
  if (!canDecideProposals(ctx)) return 0;
  const res = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from wa_calendar_proposals
     where workspace_id = app_current_workspace_id() and status = 'pending'`);
  return Number(res.rows[0]?.n ?? 0);
}

export async function getProposal(tx: Tx, ctx: TenantContext, id: string): Promise<WaProposalView> {
  if (!canDecideProposals(ctx)) throw forbidden();
  if (!isUuid(id)) throw notFound("Öneri bulunamadı.");
  const res = await tx.execute<Row>(sql`
    ${SELECT}
    where pr.id = ${id}::uuid and pr.workspace_id = app_current_workspace_id()`);
  const row = res.rows[0];
  if (!row) throw notFound("Öneri bulunamadı.");
  return toView(row, await candidateNames(tx, row.candidate_property_ids ?? []));
}

/** Onay ekranı için mevcut takvim çakışmaları (Kiraligim kayıtları + harici iCal). */
export async function proposalConflicts(
  tx: Tx,
  propertyId: string | null,
  checkIn: string | null,
  checkOut: string | null,
): Promise<{ internal: Conflict[]; external: ExternalConflict[] }> {
  if (!propertyId || !checkIn || !checkOut || checkOut <= checkIn) {
    return { internal: [], external: [] };
  }
  return {
    internal: await findConflicts(tx, propertyId, checkIn, checkOut),
    external: await findExternalConflicts(tx, propertyId, checkIn, checkOut),
  };
}

export type ApproveInput = {
  version: unknown;
  propertyId: unknown;
  checkIn: unknown;
  checkOut: unknown;
  /** Yalnız reserve. */
  guestName?: unknown;
  adults?: unknown;
  children?: unknown;
  status?: unknown;
  note?: unknown;
};

const NOTE_MAX = 500;

function versionOf(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1) throw validationError({}, "Öneri sürümü geçersiz.");
  return n;
}

function noteOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  if (t.length > NOTE_MAX) {
    throw validationError({ note: [`Not en fazla ${NOTE_MAX} karakter olabilir.`] });
  }
  return t;
}

type Locked = {
  id: string;
  version: number;
  status: WaProposalStatus;
  action: WaProposalView["action"];
  property_id: string | null;
  check_in: string | null;
  check_out: string | null;
  review_reasons: string[];
};

/** Öneriyi kilitler; bekleyen ve beklenen sürümde değilse durur (iyimser kilit). */
async function lockPending(tx: Tx, id: string, version: number): Promise<Locked> {
  if (!isUuid(id)) throw notFound("Öneri bulunamadı.");
  const res = await tx.execute<Locked>(sql`
    select id, version, status, action, property_id,
           to_char(check_in, 'YYYY-MM-DD') as check_in,
           to_char(check_out, 'YYYY-MM-DD') as check_out, review_reasons
      from wa_calendar_proposals
     where id = ${id}::uuid and workspace_id = app_current_workspace_id()
     for update`);
  const p = res.rows[0];
  if (!p) throw notFound("Öneri bulunamadı.");
  if (p.status !== "pending") throw conflict("Bu öneri için zaten karar verilmiş.");
  if (Number(p.version) !== version) {
    throw conflict("Öneri bu arada değişti. Sayfayı yenileyip yeniden inceleyin.");
  }
  return { ...p, version: Number(p.version) };
}

/**
 * Öneriyi onaylar: rezervasyon (reserve) veya blok (close) oluşturur ve öneriyi "applied" yapar
 * (tek transaction). Yönetici villa, tarih, misafir bilgilerini onaydan önce düzeltebilir;
 * değişiklik "edited" olarak işaretlenir. Çakışma, kapasite veya pasif mülk durumunda
 * rezervasyon servisi hata verir ve HİÇBİR şey yazılmaz. Dönüş: oluşan kaydın kimliği.
 */
export async function approveProposal(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  input: ApproveInput,
): Promise<{ reservationId: string }> {
  if (!canDecideProposals(ctx)) throw forbidden();
  const p = await lockPending(tx, id, versionOf(input.version));
  if (!p.action || !(WA_APPLICABLE_ACTIONS as readonly string[]).includes(p.action)) {
    throw new AppError(
      "CONFLICT",
      "Bu öneri türü (açma / iptal) panelden henüz uygulanamıyor. Takvimde elle işleyip öneriyi reddedin.",
    );
  }
  const action = p.action as ApplicableAction;
  const propertyId = typeof input.propertyId === "string" ? input.propertyId : "";
  const checkIn = typeof input.checkIn === "string" ? input.checkIn : "";
  const checkOut = typeof input.checkOut === "string" ? input.checkOut : "";
  const note = noteOf(input.note);
  if (!isUuid(propertyId)) throw validationError({ propertyId: ["Villa seçin."] });

  const status: ReservationStatus =
    input.status === "pending"
      ? "pending"
      : input.status === "confirmed"
        ? "confirmed"
        : "confirmed";
  const reservationId =
    action === "reserve"
      ? await createReservation(
          tx,
          ctx,
          {
            kind: "reservation",
            propertyId,
            checkIn,
            checkOut,
            status,
            source: "whatsapp",
            guestName: input.guestName,
            adults: input.adults,
            children: input.children,
            note: note ?? undefined,
          },
          { originProposalId: p.id },
        )
      : await createReservation(
          tx,
          ctx,
          { kind: "block", propertyId, checkIn, checkOut, note: note ?? undefined },
          { originProposalId: p.id },
        );

  const edited = propertyId !== p.property_id || checkIn !== p.check_in || checkOut !== p.check_out;
  await tx.execute(sql`
    update wa_calendar_proposals
       set property_id = ${propertyId}::uuid,
           check_in = ${checkIn}::date,
           check_out = ${checkOut}::date,
           reservation_status = ${action === "reserve" ? status : null},
           edited = edited or ${edited},
           status = 'applied',
           decided_by = app_current_user_id(),
           decided_at = now(),
           decision_mode = 'reviewed',
           decision_reasons = review_reasons,
           decision_note = ${note},
           applied_reservation_ids = array[${reservationId}::uuid]
     where id = ${p.id}::uuid`);
  await recordAudit(tx, {
    action: "whatsapp.proposal_applied",
    targetType: "whatsapp_proposal",
    targetId: p.id,
    metadata: { property: propertyId, action, reservation: reservationId, edited },
  });
  return { reservationId };
}

/** Öneriyi reddeder (takvim değişmez). */
export async function rejectProposal(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  input: { version: unknown; note?: unknown },
): Promise<void> {
  if (!canDecideProposals(ctx)) throw forbidden();
  const p = await lockPending(tx, id, versionOf(input.version));
  const note = noteOf(input.note);
  await tx.execute(sql`
    update wa_calendar_proposals
       set status = 'rejected', decided_by = app_current_user_id(), decided_at = now(),
           decision_note = ${note}
     where id = ${p.id}::uuid`);
  await recordAudit(tx, {
    action: "whatsapp.proposal_rejected",
    targetType: "whatsapp_proposal",
    targetId: p.id,
    metadata: {},
  });
}

/** Onay formunun varsayılanları (öneriden). */
export function approvalDefaults(p: WaProposalView) {
  const today = istanbulToday();
  return {
    propertyId: p.propertyId ?? (p.candidates.length === 1 ? p.candidates[0]!.id : ""),
    checkIn: p.checkIn ?? today,
    checkOut: p.checkOut ?? "",
    adults: p.guests.adults ?? null,
    children: p.guests.children ?? 0,
    status: p.reservationStatus ?? "confirmed",
  };
}
