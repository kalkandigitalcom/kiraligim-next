/**
 * Super Admin — merkezi WhatsApp grup yönetimi (Aşama 2). Tüm işlemler app_admin bağlantısıyla
 * yalnız veritabanı fonksiyonları (app_wa_admin_*, drizzle/0044) üzerinden yapılır: yönetici
 * kimliği, işletme ve villa veritabanında yeniden doğrulanır; denetim kayıtlarını fonksiyonlar yazar.
 * Grup kimliği ve adı Gateway'in kaydından gelir; istemciden gelen serbest metinle yetki verilmez.
 */
import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { AppError, notFound } from "@/lib/errors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export type AdminGroupStatus = "discovered" | "linked" | "suspended" | "left";
export type AdminGroupTab = "bekleyen" | "aktif" | "pasif" | "arsiv" | "tum";

export type AdminWaGroup = {
  id: string;
  jid: string;
  subject: string | null;
  status: AdminGroupStatus;
  participantCount: number;
  botIsAdmin: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastMessageAt: Date | null;
  linkedAt: Date | null;
  archivedAt: Date | null;
  workspaceId: string | null;
  workspaceName: string | null;
  propertyId: string | null;
  propertyName: string | null;
  propertyActive: boolean | null;
  connectionLabel: string;
  /** Aynı JID'li kayıt sayısı (>1: başka bir bağlantıdan da keşfedilmiş). */
  sameJidCount: number;
};

type GroupRow = {
  id: string;
  jid: string;
  subject: string | null;
  status: AdminGroupStatus;
  participant_count: number;
  bot_is_admin: boolean;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  last_message_at: Date | string | null;
  linked_at: Date | string | null;
  archived_at: Date | string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  property_id: string | null;
  property_name: string | null;
  property_active: boolean | null;
  connection_label: string;
  same_jid_count: number;
};

const d = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));

function toGroup(r: GroupRow): AdminWaGroup {
  return {
    id: r.id,
    jid: r.jid,
    subject: r.subject,
    status: r.status,
    participantCount: Number(r.participant_count),
    botIsAdmin: r.bot_is_admin,
    firstSeenAt: new Date(r.first_seen_at),
    lastSeenAt: new Date(r.last_seen_at),
    lastMessageAt: d(r.last_message_at),
    linkedAt: d(r.linked_at),
    archivedAt: d(r.archived_at),
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    propertyId: r.property_id,
    propertyName: r.property_name,
    propertyActive: r.property_active,
    connectionLabel: r.connection_label,
    sameJidCount: Number(r.same_jid_count),
  };
}

/** Hangi sekmede görünür? (bekleyen: hiçbir işletmeye bağlı değil, arşivde değil, grupta) */
export function groupTab(g: AdminWaGroup): Exclude<AdminGroupTab, "tum"> | null {
  if (g.archivedAt) return "arsiv";
  if (g.workspaceId === null) return g.status === "discovered" ? "bekleyen" : null;
  if (g.status === "linked") return "aktif";
  return "pasif"; // suspended veya gruptan çıkarılmış (left) ama hâlâ bağlı
}

export async function listAdminGroups(db: Database, adminId: string): Promise<AdminWaGroup[]> {
  const res = await db.execute<GroupRow>(
    sql`select * from public.app_wa_admin_groups(${adminId}::uuid)`,
  );
  return res.rows.map(toGroup);
}

export async function getAdminGroup(
  db: Database,
  adminId: string,
  groupId: string,
): Promise<AdminWaGroup> {
  if (!isUuid(groupId)) throw notFound("Grup bulunamadı.");
  const res = await db.execute<GroupRow>(
    sql`select * from public.app_wa_admin_groups(${adminId}::uuid) where id = ${groupId}::uuid`,
  );
  const row = res.rows[0];
  if (!row) throw notFound("Grup bulunamadı.");
  return toGroup(row);
}

export type AdminWorkspaceOption = { id: string; name: string; slug: string; active: boolean };

export async function searchAdminWorkspaces(
  db: Database,
  adminId: string,
  query: string,
): Promise<AdminWorkspaceOption[]> {
  const res = await db.execute<{ id: string; name: string; slug: string; status: string }>(
    sql`select * from public.app_wa_admin_workspaces(${adminId}::uuid, ${query.slice(0, 100)})`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    active: r.status === "active",
  }));
}

export type AdminPropertyOption = { id: string; name: string; active: boolean };

export async function listAdminProperties(
  db: Database,
  adminId: string,
  workspaceId: string,
): Promise<AdminPropertyOption[]> {
  if (!isUuid(workspaceId)) return [];
  const res = await db.execute<AdminPropertyOption>(
    sql`select * from public.app_wa_admin_properties(${adminId}::uuid, ${workspaceId}::uuid)`,
  );
  return res.rows;
}

export type AdminConnection = {
  id: string;
  label: string;
  status: string;
  lastSeenAt: Date | null;
  lastConnectedAt: Date | null;
  lastErrorCode: string | null;
};

export async function listAdminConnections(
  db: Database,
  adminId: string,
): Promise<AdminConnection[]> {
  const res = await db.execute<{
    id: string;
    label: string;
    status: string;
    last_seen_at: Date | string | null;
    last_connected_at: Date | string | null;
    last_error_code: string | null;
  }>(sql`select * from public.app_wa_admin_connections(${adminId}::uuid)`);
  return res.rows.map((r) => ({
    id: r.id,
    label: r.label,
    status: r.status,
    lastSeenAt: d(r.last_seen_at),
    lastConnectedAt: d(r.last_connected_at),
    lastErrorCode: r.last_error_code,
  }));
}

export type AdminGroupEvent = {
  id: string;
  occurredAt: Date;
  adminName: string | null;
  action: string;
  metadata: Record<string, unknown>;
};

/** Grubun eşleştirme geçmişi (platform denetim kaydı). */
export async function listAdminGroupHistory(
  db: Database,
  groupId: string,
): Promise<AdminGroupEvent[]> {
  if (!isUuid(groupId)) return [];
  const res = await db.execute<{
    id: string;
    occurred_at: Date | string;
    admin_name: string | null;
    action: string;
    metadata: Record<string, unknown>;
  }>(sql`
    select l.id, l.occurred_at, a.name as admin_name, l.action, l.metadata
      from admin_audit_log l left join admin_users a on a.id = l.admin_id
     where l.target_type = 'wa_group' and l.target_id = ${groupId}::uuid
     order by l.occurred_at desc, l.id desc
     limit 100`);
  return res.rows.map((r) => ({
    id: r.id,
    occurredAt: new Date(r.occurred_at),
    adminName: r.admin_name,
    action: r.action,
    metadata: r.metadata ?? {},
  }));
}

/** İşlem sonucu hata kodları (sayfada sabit Türkçe metinle gösterilir; URL'de yalnız kod). */
export const ADMIN_WA_ERRORS = {
  not_found: "Grup bulunamadı.",
  not_available: "Bu grup şu anda bu işlem için uygun değil (bağlı veya gruptan çıkarılmış).",
  archived: "Grup arşivde. Önce arşivden çıkarın.",
  duplicate:
    "Aynı WhatsApp grubu başka bir bağlantı kaydıyla zaten bağlı. Bu mükerrer kaydı arşivleyin.",
  workspace_invalid: "İşletme bulunamadı veya aktif değil.",
  property_invalid: "Villa, seçilen işletmeye ait aktif bir villa olmalı.",
  confirm_required: "Onay kutusunu işaretleyin.",
  phone_invalid:
    "Numarayı ülke koduyla yazın (ör. 90 5xx xxx xx xx). Yalnız rakam, boşluk, + ve - kullanılabilir.",
  block_exists: "Bu numara bu kapsamda zaten engelli.",
  block_not_found: "Engel kaydı bulunamadı.",
  error: "İşlem tamamlanamadı. Yeniden deneyin.",
} as const;
export type AdminWaErrorCode = keyof typeof ADMIN_WA_ERRORS;

export class AdminWaError extends AppError {
  constructor(readonly reason: AdminWaErrorCode) {
    super(reason === "not_found" ? "NOT_FOUND" : "CONFLICT", ADMIN_WA_ERRORS[reason]);
  }
}

function outcome(out: string | undefined, ok: readonly string[]): string {
  if (out && ok.includes(out)) return out;
  const reason = (out && out in ADMIN_WA_ERRORS ? out : "error") as AdminWaErrorCode;
  throw new AdminWaError(reason);
}

async function call(db: Database, q: ReturnType<typeof sql>): Promise<string | undefined> {
  const res = await db.execute<{ out: string }>(q);
  return res.rows[0]?.out;
}

export async function linkAdminGroup(
  db: Database,
  adminId: string,
  input: { groupId: unknown; workspaceId: unknown; propertyId: unknown },
): Promise<void> {
  if (!isUuid(input.groupId)) throw new AdminWaError("not_found");
  if (!isUuid(input.workspaceId)) throw new AdminWaError("workspace_invalid");
  if (!isUuid(input.propertyId)) throw new AdminWaError("property_invalid");
  outcome(
    await call(
      db,
      sql`select public.app_wa_admin_link_group(${adminId}::uuid, ${input.groupId}::uuid,
            ${input.workspaceId}::uuid, ${input.propertyId}::uuid) as out`,
    ),
    ["linked"],
  );
}

export async function setAdminGroupProperty(
  db: Database,
  adminId: string,
  groupId: unknown,
  propertyId: unknown,
): Promise<{ changed: boolean }> {
  if (!isUuid(groupId)) throw notFound("Grup bulunamadı.");
  if (!isUuid(propertyId)) throw new AdminWaError("property_invalid");
  const out = outcome(
    await call(
      db,
      sql`select public.app_wa_admin_set_property(${adminId}::uuid, ${groupId}::uuid,
            ${propertyId}::uuid) as out`,
    ),
    ["changed", "unchanged"],
  );
  return { changed: out === "changed" };
}

export async function setAdminGroupActive(
  db: Database,
  adminId: string,
  groupId: unknown,
  active: boolean,
): Promise<{ changed: boolean }> {
  if (!isUuid(groupId)) throw notFound("Grup bulunamadı.");
  const out = outcome(
    await call(
      db,
      sql`select public.app_wa_admin_set_active(${adminId}::uuid, ${groupId}::uuid, ${active}) as out`,
    ),
    ["changed", "unchanged"],
  );
  return { changed: out === "changed" };
}

export async function unlinkAdminGroup(
  db: Database,
  adminId: string,
  groupId: unknown,
): Promise<void> {
  if (!isUuid(groupId)) throw notFound("Grup bulunamadı.");
  outcome(
    await call(
      db,
      sql`select public.app_wa_admin_unlink_group(${adminId}::uuid, ${groupId}::uuid) as out`,
    ),
    ["unlinked"],
  );
}

export async function archiveAdminGroup(
  db: Database,
  adminId: string,
  groupId: unknown,
  archive: boolean,
): Promise<{ changed: boolean }> {
  if (!isUuid(groupId)) throw notFound("Grup bulunamadı.");
  const out = outcome(
    await call(
      db,
      sql`select public.app_wa_admin_archive_group(${adminId}::uuid, ${groupId}::uuid, ${archive}) as out`,
    ),
    ["changed", "unchanged"],
  );
  return { changed: out === "changed" };
}

// ---------------------------------------------------------------------------------------------
// B aşaması: operasyonel komut vermesi engellenen numaralar (drizzle/0046, 0047)
// ---------------------------------------------------------------------------------------------

export type AdminBlockedSender = {
  id: string;
  /** Numaranın son 4 hanesi (numara saklanmaz). */
  phoneHint: string;
  /** Boşsa engel bütün gruplarda geçerli. */
  groupId: string | null;
  groupSubject: string | null;
  workspaceName: string | null;
  createdAt: Date;
};

/**
 * Super Admin'in girdiği numarayı WhatsApp biçimine (ülke koduyla, yalnız rakam) çevirir.
 * Boşluk, tire, parantez ve baştaki + / 00 kabul edilir; baştaki tek 0 (yurt içi biçim) Türkiye
 * numarası sayılır (05xx → 905xx). Geçersizse null.
 */
export function normalizeBlockPhone(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 40 || !/^[+0-9 ()\-.]+$/.test(raw)) return null;
  let digits = raw.replace(/[^0-9]/g, "");
  if (raw.startsWith("+")) {
    // ülke kodu zaten var
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0")) {
    digits = `90${digits.slice(1)}`;
  }
  return /^[1-9][0-9]{6,19}$/.test(digits) ? digits : null;
}

export async function listAdminBlockedSenders(
  db: Database,
  adminId: string,
): Promise<AdminBlockedSender[]> {
  const res = await db.execute<{
    id: string;
    phone_hint: string;
    group_id: string | null;
    group_subject: string | null;
    workspace_name: string | null;
    created_at: Date | string;
  }>(sql`select * from public.app_wa_admin_blocked_senders(${adminId}::uuid)`);
  return res.rows.map((r) => ({
    id: r.id,
    phoneHint: r.phone_hint,
    groupId: r.group_id,
    groupSubject: r.group_subject,
    workspaceName: r.workspace_name,
    createdAt: new Date(r.created_at),
  }));
}

/** Numarayı engeller. groupId null: bütün gruplarda. Numara loglanmaz ve saklanmaz (yalnız özet). */
export async function blockAdminSender(
  db: Database,
  adminId: string,
  input: { phone: unknown; groupId: string | null },
): Promise<void> {
  const phone = normalizeBlockPhone(input.phone);
  if (!phone) throw new AdminWaError("phone_invalid");
  if (input.groupId !== null && !isUuid(input.groupId)) throw new AdminWaError("not_found");
  const out = await call(
    db,
    sql`select public.app_wa_admin_block_sender(${adminId}::uuid, ${phone},
          ${input.groupId}::uuid) as out`,
  );
  if (out === "exists") throw new AdminWaError("block_exists");
  outcome(out, ["blocked"]);
}

export async function unblockAdminSender(
  db: Database,
  adminId: string,
  blockId: unknown,
): Promise<void> {
  if (!isUuid(blockId)) throw new AdminWaError("block_not_found");
  const out = await call(
    db,
    sql`select public.app_wa_admin_unblock_sender(${adminId}::uuid, ${blockId}::uuid) as out`,
  );
  if (out === "not_found") throw new AdminWaError("block_not_found");
  outcome(out, ["unblocked"]);
}
