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
 * Grup eşleştirme (A1.1, kodsuz): kullanıcı WhatsApp numarasını bir kez asistana ÖZEL mesajla
 * doğrular; asistanı gruba ekleyen kişinin (ya da kurucunun) numarası bu doğrulanmış numarayla
 * eşleşen gruplar "Bekleyen gruplar"da görünür ve bir villayla eşleştirilir. Eşleşme denetimi
 * veritabanı fonksiyonlarında (app_wa_pending_groups, app_wa_claim_group) yapılır.
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
  type WaClaimOutcome,
  type WaConnectionStatus,
  type WaGroupStatus,
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
  /** Asistanın WhatsApp numarası (wa.me bağlantısı için); ağ geçidi bildirmediyse null. */
  accountPn: string | null;
};

export async function getConnectionStatus(tx: Tx): Promise<WaConnectionView> {
  const res = await tx.execute<{
    status: WaConnectionStatus;
    last_seen_at: Date | string | null;
    last_connected_at: Date | string | null;
    account_pn: string | null;
    stale: boolean;
  }>(sql`
    select status, last_seen_at, last_connected_at, account_pn,
           (last_seen_at is null
             or last_seen_at < now() - make_interval(mins => ${WA_STALE_MINUTES})) as stale
      from wa_connections
     order by last_seen_at desc nulls last
     limit 1`);
  const r = res.rows[0];
  if (!r) {
    return {
      status: "none",
      stale: true,
      lastSeenAt: null,
      lastConnectedAt: null,
      accountPn: null,
    };
  }
  return {
    status: r.status,
    stale: r.stale,
    lastSeenAt: toDate(r.last_seen_at),
    lastConnectedAt: toDate(r.last_connected_at),
    accountPn: r.account_pn,
  };
}

/* ── Bağlı gruplar ─────────────────────────────────────────────────────── */

export type WaGroup = {
  id: string;
  subject: string | null;
  status: WaGroupStatus;
  participantCount: number;
  botIsAdmin: boolean;
  adminsOnly: boolean;
  linkedAt: Date | null;
  lastMessageAt: Date | null;
  propertyId: string | null;
  propertyName: string | null;
  /** Son 7 gündeki kayıtlı mesaj sayısı; mesaj görme yetkisi yoksa null. */
  messages7d: number | null;
};

/** Bu işletmeye bağlı gruplar (bekleyenler ayrı: listPendingGroups). */
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
    property_id: string | null;
    property_name: string | null;
  }>(sql`
    select g.id, g.subject, g.status, g.participant_count, g.bot_is_admin, g.admins_only,
           g.linked_at, g.last_message_at, g.property_id, p.name as property_name
      from wa_groups g
      left join properties p on p.id = g.property_id and p.workspace_id = g.workspace_id
     where g.workspace_id = app_current_workspace_id()
     order by (g.status = 'linked') desc, lower(coalesce(g.subject, '')), g.id`);
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
    propertyId: r.property_id,
    propertyName: r.property_name,
    messages7d: canViewWhatsappMessages(ctx) ? (counts.get(r.id) ?? 0) : null,
  }));
}

/* ── Villalar (eşleştirme seçimi) ───────────────────────────────────────── */

export type WaPropertyOption = { id: string; name: string; active: boolean };

/** Yalnız bu işletmenin villaları (RLS); eşleştirme listesinde gösterilir. */
export async function listPropertyOptions(tx: Tx): Promise<WaPropertyOption[]> {
  const res = await tx.execute<{ id: string; name: string; status: string }>(sql`
    select id, name, status from properties
     where workspace_id = app_current_workspace_id()
     order by (status = 'active') desc, lower(name), id`);
  return res.rows.map((r) => ({ id: r.id, name: r.name, active: r.status === "active" }));
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

/* ── Numara doğrulama (asistana özel mesajla, bir kez) ─────────────────── */

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export type WaMyPhone = { masked: string; verifiedAt: Date } | null;

/** Oturumdaki kullanıcının doğrulanmış numarası (yalnız maskeli; RLS: yalnız kendi kaydı). */
export async function getMyPhone(tx: Tx): Promise<WaMyPhone> {
  const res = await tx.execute<{ phone_masked: string; verified_at: Date | string }>(sql`
    select phone_masked, verified_at from wa_verified_phones
     where user_id = app_current_user_id()`);
  const r = res.rows[0];
  return r ? { masked: r.phone_masked, verifiedAt: toDate(r.verified_at)! } : null;
}

export type PhoneChallengeIssued = { id: string; code: string; expiresAt: Date };

/**
 * Tek kullanımlık, 10 dakikalık doğrulama kodu. Kod düz metin saklanmaz (koda özel tuzla SHA-256)
 * ve yalnız bu yanıtta bir kez döner. Kullanıcı kodu asistana ÖZEL mesajla gönderir; numarası
 * WhatsApp'ın bildirdiği gönderen numarasıdır (panelde numara yazılmaz).
 */
export async function createPhoneChallenge(
  tx: Tx,
  ctx: TenantContext,
): Promise<PhoneChallengeIssued> {
  if (!(await canManageWhatsapp(tx, ctx))) throw forbidden();
  const code = generateLinkCode((n) => randomBytes(n));
  const salt = randomBytes(16).toString("hex");
  const id = uuidv7();
  const res = await tx.execute<{ expires_at: Date | string }>(sql`
    insert into wa_phone_challenges (id, user_id, workspace_id, code_salt, code_hash, expires_at)
    values (${id}, app_current_user_id(), app_current_workspace_id(), ${salt},
            ${sha256(`${salt}:${code}`)},
            now() + make_interval(mins => ${WA_LINK_CODE_TTL_MINUTES}))
    returning expires_at`);
  await recordAudit(tx, {
    action: "whatsapp.phone_verification_created",
    targetType: "user",
    targetId: ctx.userId,
    metadata: {},
  });
  return { id, code, expiresAt: toDate(res.rows[0]!.expires_at)! };
}

export type PhoneChallengeState =
  | { state: "pending"; expiresAt: Date }
  | { state: "used"; masked: string | null }
  | { state: "expired" };

/** Kodu üreten kişi için durum (RLS: başkasının kodu görünmez). */
export async function getPhoneChallengeState(
  tx: Tx,
  challengeId: string,
): Promise<PhoneChallengeState> {
  if (!isUuid(challengeId)) throw notFound("Kod bulunamadı.");
  const res = await tx.execute<{
    expires_at: Date | string;
    used_at: Date | string | null;
    expired: boolean;
  }>(sql`
    select expires_at, used_at, (expires_at <= now()) as expired
      from wa_phone_challenges where id = ${challengeId}`);
  const r = res.rows[0];
  if (!r) throw notFound("Kod bulunamadı.");
  if (r.used_at) return { state: "used", masked: (await getMyPhone(tx))?.masked ?? null };
  if (r.expired) return { state: "expired" };
  return { state: "pending", expiresAt: toDate(r.expires_at)! };
}

/** Kendi doğrulanmış numarasını kaldırır (bekleyen gruplar artık görünmez; bağlı gruplar etkilenmez). */
export async function removeMyPhone(tx: Tx, ctx: TenantContext): Promise<{ changed: boolean }> {
  const res = await tx.execute(sql`
    delete from wa_verified_phones where user_id = app_current_user_id()`);
  if (!res.rowCount) return { changed: false };
  await recordAudit(tx, {
    action: "whatsapp.phone_removed",
    targetType: "user",
    targetId: ctx.userId,
    metadata: {},
  });
  return { changed: true };
}

/* ── Bekleyen gruplar ve eşleştirme ─────────────────────────────────────── */

export type WaPendingGroup = {
  id: string;
  subject: string | null;
  participantCount: number;
  discoveredAt: Date;
  /** Eşleşme nedeni: asistanı siz eklediniz ya da grubu siz kurdunuz. */
  match: "added_by" | "owner";
};

/**
 * Yalnız oturumdaki kullanıcının doğrulanmış numarasıyla eşleşen, henüz hiçbir işletmeye bağlı
 * olmayan gruplar (veritabanı fonksiyonu süzer; başka grupların adı bile gelmez).
 */
export async function listPendingGroups(tx: Tx, ctx: TenantContext): Promise<WaPendingGroup[]> {
  if (!(await canManageWhatsapp(tx, ctx))) return [];
  const res = await tx.execute<{
    id: string;
    subject: string | null;
    participant_count: number;
    first_seen_at: Date | string;
    match: "added_by" | "owner";
  }>(sql`select * from public.app_wa_pending_groups()`);
  return res.rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    participantCount: r.participant_count,
    discoveredAt: toDate(r.first_seen_at)!,
    match: r.match,
  }));
}

export const claimGroupInput = z.object({
  groupId: z.string({ error: "Grup seçin." }).trim().min(1, { error: "Grup seçin." }),
  propertyId: z.string({ error: "Villa seçin." }).trim().min(1, { error: "Villa seçin." }),
});

/**
 * Bekleyen grubu bir villayla eşleştirir; grup aktif olur ve mesajları kaydedilmeye başlar.
 * Yetki, numara eşleşmesi, grubun boşta olması ve villanın bu işletmeye ait olması veritabanında
 * (app_wa_claim_group) yeniden denetlenir. Audit'i fonksiyon yazar.
 */
export async function claimGroup(tx: Tx, ctx: TenantContext, input: unknown): Promise<void> {
  if (!(await canManageWhatsapp(tx, ctx))) throw forbidden();
  const parsed = claimGroupInput.safeParse(input);
  if (!parsed.success) {
    const f = parsed.error.flatten().fieldErrors;
    throw validationError({
      ...(f.groupId ? { groupId: f.groupId } : {}),
      ...(f.propertyId ? { propertyId: f.propertyId } : {}),
    });
  }
  const { groupId, propertyId } = parsed.data;
  if (!isUuid(groupId)) throw groupNotFound();
  if (!isUuid(propertyId)) throw validationError({ propertyId: ["Villa bulunamadı."] });
  const res = await tx.execute<{ out: WaClaimOutcome }>(
    sql`select public.app_wa_claim_group(${groupId}::uuid, ${propertyId}::uuid) as out`,
  );
  switch (res.rows[0]?.out) {
    case "linked":
      return;
    case "forbidden":
      throw forbidden();
    case "not_verified":
      throw new AppError("CONFLICT", "Önce WhatsApp numaranızı doğrulayın.");
    case "property_not_found":
      throw validationError({ propertyId: ["Villa bulunamadı."] });
    default:
      throw notFound("Grup bulunamadı veya artık eşleştirilemez.");
  }
}

/** Bağlı (veya askıdaki) grubun villasını değiştirir. Villa bu işletmenin olmalı (bileşik FK). */
export async function setGroupProperty(
  tx: Tx,
  ctx: TenantContext,
  groupId: string,
  propertyId: string,
): Promise<{ changed: boolean }> {
  if (!(await canManageWhatsapp(tx, ctx))) throw forbidden();
  if (!isUuid(groupId)) throw groupNotFound();
  if (!isUuid(propertyId)) throw validationError({ propertyId: ["Villa bulunamadı."] });
  const prop = await tx.execute<{ id: string }>(sql`
    select id from properties where id = ${propertyId} and workspace_id = app_current_workspace_id()`);
  if (!prop.rows[0]) throw validationError({ propertyId: ["Villa bulunamadı."] });
  const res = await tx.execute(sql`
    update wa_groups set property_id = ${propertyId}
     where id = ${groupId} and workspace_id = app_current_workspace_id()
       and status in ('linked', 'suspended')
       and property_id is distinct from ${propertyId}::uuid`);
  if (!res.rowCount) {
    const cur = await tx.execute<{ property_id: string | null }>(sql`
      select property_id from wa_groups
       where id = ${groupId} and workspace_id = app_current_workspace_id()
         and status in ('linked', 'suspended')`);
    if (!cur.rows[0]) throw groupNotFound();
    return { changed: false };
  }
  await recordAudit(tx, {
    action: "whatsapp.group_property_changed",
    targetType: "whatsapp_group",
    targetId: groupId,
    metadata: { property: propertyId },
  });
  return { changed: true };
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
