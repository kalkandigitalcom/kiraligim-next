/**
 * WhatsApp Asistanı — A1 panel servisi (yalnız okuma ve grup yönetimi). TÜM fonksiyonlar
 * withTenant içinden (tx + ctx) çağrılır: işletme ve kullanıcı oturumdan gelir, RLS (FORCE) başka
 * işletmenin gruplarını ve mesajlarını göstermez, yazma yetkileri veritabanı politikalarında
 * yeniden denetlenir (app_wa_can_manage).
 *
 * Yetki:
 *  - Görüntüleme: tüm üyeler grupları ve bağlantı durumunu; mesajları yalnız owner ve manager.
 *  - Kod üretme, askıya alma/devam ettirme, bağlantı kesme: owner ve owner'ın yetkilendirdiği
 *    manager.
 *  - Manager yetkilendirme: yalnız owner.
 *
 * Rezervasyon, fiyat ve iCal tablolarına dokunulmaz. Kod ve telefon düz metin saklanmaz.
 */
import { createHash, randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";

import type { TenantContext, Tx } from "@/db/tenant";
import { AppError, forbidden, notFound, validationError } from "@/lib/errors";
import {
  generateLinkCode,
  WA_LINK_CODE_TTL_MINUTES,
  WA_STALE_MINUTES,
  type WaConnectionStatus,
  type WaGroupStatus,
  normalizePhone,
} from "@/lib/whatsapp-meta";
import { recordAudit } from "@/server/audit/record";
import { isUuid } from "@/server/properties/service";

const toDate = (v: Date | string | null) =>
  v == null ? null : v instanceof Date ? v : new Date(v);

/** Kod üretme, askıya alma ve bağlantı kesme yetkisi (owner ya da yetkili manager). */
export async function canManageWhatsapp(tx: Tx, ctx: TenantContext): Promise<boolean> {
  if (ctx.role === "owner") return true;
  if (ctx.role !== "manager") return false;
  const res = await tx.execute<{ ok: boolean }>(sql`select public.app_wa_can_manage() as ok`);
  return res.rows[0]?.ok === true;
}

export const canViewWhatsappMessages = (ctx: TenantContext) =>
  ctx.role === "owner" || ctx.role === "manager";

/* ── Bağlantı durumu ────────────────────────────────────────────────────── */

export type WaConnectionView = {
  status: WaConnectionStatus | "none";
  /** Kalp atışı WA_STALE_MINUTES'ten eskiyse bağlantı yok sayılır. */
  stale: boolean;
  lastSeenAt: Date | null;
  lastConnectedAt: Date | null;
};

export async function getConnectionStatus(tx: Tx): Promise<WaConnectionView> {
  const res = await tx.execute<{
    status: WaConnectionStatus;
    last_seen_at: Date | string | null;
    last_connected_at: Date | string | null;
    stale: boolean;
  }>(sql`
    select status, last_seen_at, last_connected_at,
           (last_seen_at is null
             or last_seen_at < now() - make_interval(mins => ${WA_STALE_MINUTES})) as stale
      from wa_connections
     order by last_seen_at desc nulls last
     limit 1`);
  const r = res.rows[0];
  if (!r) return { status: "none", stale: true, lastSeenAt: null, lastConnectedAt: null };
  return {
    status: r.status,
    stale: r.stale,
    lastSeenAt: toDate(r.last_seen_at),
    lastConnectedAt: toDate(r.last_connected_at),
  };
}

/* ── Gruplar ────────────────────────────────────────────────────────────── */

export type WaGroup = {
  id: string;
  subject: string | null;
  status: WaGroupStatus;
  participantCount: number;
  botIsAdmin: boolean;
  adminsOnly: boolean;
  linkedAt: Date | null;
  lastMessageAt: Date | null;
  /** Son 7 gündeki kayıtlı mesaj sayısı; mesaj görme yetkisi yoksa null. */
  messages7d: number | null;
};

export async function listGroups(tx: Tx, ctx: TenantContext): Promise<WaGroup[]> {
  const res = await tx.execute<{
    id: string;
    subject: string | null;
    status: WaGroupStatus;
    participant_count: number;
    bot_is_admin: boolean;
    admins_only: boolean;
    linked_at: Date | string | null;
    last_message_at: Date | string | null;
  }>(sql`
    select id, subject, status, participant_count, bot_is_admin, admins_only, linked_at,
           last_message_at
      from wa_groups
     where workspace_id = app_current_workspace_id()
     order by (status = 'linked') desc, lower(coalesce(subject, '')), id`);
  let counts = new Map<string, number>();
  if (canViewWhatsappMessages(ctx) && res.rows.length) {
    const c = await tx.execute<{ group_id: string; n: number }>(sql`
      select group_id, count(*)::int as n
        from wa_inbound_messages
       where workspace_id = app_current_workspace_id()
         and received_at > now() - interval '7 days'
       group by group_id`);
    counts = new Map(c.rows.map((r) => [r.group_id, r.n]));
  }
  return res.rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    status: r.status,
    participantCount: r.participant_count,
    botIsAdmin: r.bot_is_admin,
    adminsOnly: r.admins_only,
    linkedAt: toDate(r.linked_at),
    lastMessageAt: toDate(r.last_message_at),
    messages7d: canViewWhatsappMessages(ctx) ? (counts.get(r.id) ?? 0) : null,
  }));
}

const groupNotFound = () => notFound("Grup bulunamadı.");

/** Aktif ↔ askıda. Askıdaki grubun mesajları kaydedilmez. */
export async function setGroupSuspended(
  tx: Tx,
  ctx: TenantContext,
  groupId: string,
  suspended: boolean,
): Promise<{ changed: boolean }> {
  if (!(await canManageWhatsapp(tx, ctx))) throw forbidden();
  if (!isUuid(groupId)) throw groupNotFound();
  const from = suspended ? "linked" : "suspended";
  const to = suspended ? "suspended" : "linked";
  // Tek adımlı koşullu güncelleme (yarış yok); olmazsa güncel durum okunup nedeni söylenir.
  // ("Ayrıldı" grubu güncelleme politikası dışında kaldığı için FOR UPDATE ile görünmez.)
  const upd = await tx.execute(sql`
    update wa_groups set status = ${to}
     where id = ${groupId} and workspace_id = app_current_workspace_id() and status = ${from}`);
  if (!upd.rowCount) {
    const cur = await tx.execute<{ status: WaGroupStatus }>(sql`
      select status from wa_groups
       where id = ${groupId} and workspace_id = app_current_workspace_id()`);
    const row = cur.rows[0];
    if (!row || row.status === "discovered") throw groupNotFound();
    if (row.status === to) return { changed: false };
    throw new AppError("CONFLICT", "Kiraligim bu gruptan çıkarılmış; durum değiştirilemez.");
  }
  await recordAudit(tx, {
    action: suspended ? "whatsapp.group_suspended" : "whatsapp.group_resumed",
    targetType: "whatsapp_group",
    targetId: groupId,
    metadata: {},
  });
  return { changed: true };
}

/** Bağlantıyı keser; grubun kayıtlı mesajları hemen silinir (veritabanı fonksiyonu, audit dahil). */
export async function unlinkGroup(tx: Tx, ctx: TenantContext, groupId: string): Promise<void> {
  if (!(await canManageWhatsapp(tx, ctx))) throw forbidden();
  if (!isUuid(groupId)) throw groupNotFound();
  const res = await tx.execute<{ out: string }>(
    sql`select public.app_wa_unlink_group(${groupId}::uuid) as out`,
  );
  const out = res.rows[0]?.out;
  if (out === "forbidden") throw forbidden();
  if (out !== "unlinked") throw groupNotFound();
}

/* ── Bağlama kodu ───────────────────────────────────────────────────────── */

export const linkCodeInput = z.object({
  phone: z
    .string({ error: "WhatsApp numaranızı girin." })
    .trim()
    .min(1, { error: "WhatsApp numaranızı girin.", abort: true })
    .transform((s, ctx) => {
      const n = normalizePhone(s);
      if (!n) {
        ctx.addIssue({
          code: "custom",
          message: "Ülke koduyla geçerli bir numara girin (ör. +90 532 123 45 67).",
        });
        return z.NEVER;
      }
      return n;
    }),
});

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export type LinkCodeIssued = { id: string; code: string; expiresAt: Date };

/**
 * Tek kullanımlık, 10 dakikalık bağlama kodu. Kod ve telefon düz metin saklanmaz (koda özel tuzla
 * SHA-256); kod yalnız bu yanıtta bir kez döner. Gruba yalnız buradaki numaradan yazılırsa geçerlidir.
 */
export async function createLinkCode(
  tx: Tx,
  ctx: TenantContext,
  input: unknown,
): Promise<LinkCodeIssued> {
  if (!(await canManageWhatsapp(tx, ctx))) throw forbidden();
  const parsed = linkCodeInput.safeParse(input);
  if (!parsed.success) {
    throw validationError({
      phone: [parsed.error.issues[0]?.message ?? "Geçerli bir numara girin."],
    });
  }
  const code = generateLinkCode((n) => randomBytes(n));
  const salt = randomBytes(16).toString("hex");
  const id = uuidv7();
  const res = await tx.execute<{ expires_at: Date | string }>(sql`
    insert into wa_link_codes (id, workspace_id, created_by, code_salt, code_hash, phone_hash,
                               expires_at)
    values (${id}, app_current_workspace_id(), app_current_user_id(), ${salt},
            ${sha256(`${salt}:${code}`)}, ${sha256(`${salt}:phone:${parsed.data.phone}`)},
            now() + make_interval(mins => ${WA_LINK_CODE_TTL_MINUTES}))
    returning expires_at`);
  await recordAudit(tx, {
    action: "whatsapp.link_code_created",
    targetType: "whatsapp_link_code",
    targetId: id,
    metadata: {},
  });
  return { id, code, expiresAt: toDate(res.rows[0]!.expires_at)! };
}

export type LinkCodeState =
  | { state: "pending"; expiresAt: Date }
  | { state: "used"; groupSubject: string | null }
  | { state: "expired" };

/** Kodu üreten kişi için durum (RLS: başkasının kodu görünmez). */
export async function getLinkCodeState(tx: Tx, codeId: string): Promise<LinkCodeState> {
  if (!isUuid(codeId)) throw notFound("Kod bulunamadı.");
  const res = await tx.execute<{
    expires_at: Date | string;
    used_at: Date | string | null;
    expired: boolean;
    subject: string | null;
  }>(sql`
    select c.expires_at, c.used_at, (c.expires_at <= now()) as expired, g.subject
      from wa_link_codes c
      left join wa_groups g on g.id = c.used_group_id
     where c.id = ${codeId}`);
  const r = res.rows[0];
  if (!r) throw notFound("Kod bulunamadı.");
  if (r.used_at) return { state: "used", groupSubject: r.subject };
  if (r.expired) return { state: "expired" };
  return { state: "pending", expiresAt: toDate(r.expires_at)! };
}

/* ── Manager yetkilendirme (yalnız owner) ───────────────────────────────── */

export type WaManager = { userId: string; name: string; authorized: boolean };

export async function listManagers(tx: Tx): Promise<WaManager[]> {
  const res = await tx.execute<{ user_id: string; name: string; authorized: boolean }>(
    sql`
    select m.user_id, u.name, (l.user_id is not null) as authorized
      from workspace_members m
      join users u on u.id = m.user_id
      left join wa_link_managers l
        on l.workspace_id = m.workspace_id and l.user_id = m.user_id
     where m.workspace_id = app_current_workspace_id() and m.role = 'manager'
     order by lower(u.name), m.user_id`,
  );
  return res.rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    authorized: r.authorized,
  }));
}

export async function setManagerAuthorized(
  tx: Tx,
  ctx: TenantContext,
  userId: string,
  authorized: boolean,
): Promise<{ changed: boolean }> {
  if (ctx.role !== "owner") throw forbidden("Bu yetkiyi yalnız işletme sahibi verebilir.");
  if (!isUuid(userId)) throw notFound("Yönetici bulunamadı.");
  const member = await tx.execute<{ role: string }>(sql`
    select role from workspace_members
     where workspace_id = app_current_workspace_id() and user_id = ${userId}`);
  if (member.rows[0]?.role !== "manager") throw notFound("Yönetici bulunamadı.");
  if (authorized) {
    const res = await tx.execute(sql`
      insert into wa_link_managers (workspace_id, user_id, granted_by)
      values (app_current_workspace_id(), ${userId}, app_current_user_id())
      on conflict do nothing`);
    if (!res.rowCount) return { changed: false };
  } else {
    const res = await tx.execute(sql`
      delete from wa_link_managers
       where workspace_id = app_current_workspace_id() and user_id = ${userId}`);
    if (!res.rowCount) return { changed: false };
  }
  await recordAudit(tx, {
    action: authorized ? "whatsapp.link_manager_granted" : "whatsapp.link_manager_revoked",
    targetType: "user",
    targetId: userId,
    metadata: {},
  });
  return { changed: true };
}

/* ── Son mesajlar (yalnız owner ve manager) ─────────────────────────────── */

export type WaMessage = {
  id: string;
  senderPn: string | null;
  body: string;
  sentAt: Date;
  kind: "live" | "backlog";
};

export async function listRecentMessages(
  tx: Tx,
  ctx: TenantContext,
  groupId: string,
  limit = 50,
): Promise<WaMessage[]> {
  if (!canViewWhatsappMessages(ctx)) throw forbidden();
  if (!isUuid(groupId)) throw groupNotFound();
  const res = await tx.execute<{
    id: string;
    sender_pn: string | null;
    body: string;
    sent_at: Date | string;
    kind: "live" | "backlog";
  }>(sql`
    select id, sender_pn, body, sent_at, kind
      from wa_inbound_messages
     where group_id = ${groupId} and workspace_id = app_current_workspace_id()
     order by sent_at desc, id desc
     limit ${Math.min(Math.max(limit, 1), 100)}`);
  return res.rows.map((r) => ({
    id: r.id,
    senderPn: r.sender_pn,
    body: r.body,
    sentAt: toDate(r.sent_at)!,
    kind: r.kind,
  }));
}
