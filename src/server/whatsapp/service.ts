/**
 * WhatsApp Asistanı — işletme paneli servisi (YALNIZ OKUMA + numara doğrulama). TÜM fonksiyonlar
 * withTenant içinden (tx + ctx) çağrılır: işletme ve kullanıcı oturumdan gelir, RLS (FORCE) başka
 * işletmenin gruplarını ve mesajlarını göstermez.
 *
 * Merkezi yönetim (Aşama 2): grup keşfi, işletmeye atama, villa eşleştirme, pasife alma ve
 * bağlantı kaldırma YALNIZ Super Admin panelindedir (src/server/admin/whatsapp.ts). İşletme rolü
 * (app_user) wa_groups üzerinde güncelleme ve eşleştirme fonksiyonları üzerinde çalıştırma
 * yetkisine veritabanı seviyesinde sahip değildir (drizzle/0044).
 *
 * Yetki:
 *  - Görüntüleme: tüm üyeler kendi gruplarını ve bağlantı durumunu; mesajları yalnız owner ve
 *    manager.
 *  - Numara doğrulama (takvim talimatı gönderenin tanınması için): owner ve önceden yetkilendirilmiş
 *    manager.
 *
 * Rezervasyon, fiyat ve iCal tablolarına dokunulmaz. Kod ve telefon düz metin saklanmaz.
 */
import { createHash, randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";

import type { TenantContext, Tx } from "@/db/tenant";
import { forbidden, notFound } from "@/lib/errors";
import {
  generateLinkCode,
  WA_LINK_CODE_TTL_MINUTES,
  WA_STALE_MINUTES,
  type WaConnectionStatus,
  type WaGroupStatus,
} from "@/lib/whatsapp-meta";
import { recordAudit } from "@/server/audit/record";
import { isUuid } from "@/server/properties/service";

const toDate = (v: Date | string | null) =>
  v == null ? null : v instanceof Date ? v : new Date(v);

/** Numara doğrulama yetkisi (owner ya da önceden yetkilendirilmiş manager). */
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

/** Bu işletmeye bağlı gruplar (salt okunur; eşleştirme Super Admin'dedir). */
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

/* ── Villalar (öneri düzenleme seçimi) ──────────────────────────────────── */

export type WaPropertyOption = { id: string; name: string; active: boolean };

/** Yalnız bu işletmenin villaları (RLS); takvim önerisi düzenlemede gösterilir. */
export async function listPropertyOptions(tx: Tx): Promise<WaPropertyOption[]> {
  const res = await tx.execute<{ id: string; name: string; status: string }>(sql`
    select id, name, status from properties
     where workspace_id = app_current_workspace_id()
     order by (status = 'active') desc, lower(name), id`);
  return res.rows.map((r) => ({ id: r.id, name: r.name, active: r.status === "active" }));
}

const groupNotFound = () => notFound("Grup bulunamadı.");

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

/** Kendi doğrulanmış numarasını kaldırır (bağlı gruplar etkilenmez). */
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
