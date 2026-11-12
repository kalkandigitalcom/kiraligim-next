/**
 * Super Admin — acente API hesapları (1. aşama). Tüm işlemler app_admin bağlantısıyla yalnız
 * veritabanı fonksiyonları (app_api_admin_*, drizzle/0052) üzerinden yapılır: yönetici kimliği
 * veritabanında yeniden doğrulanır, denetim kayıtlarını fonksiyonlar yazar.
 *
 * API anahtarı ve erişim kodu burada üretilir; veritabanına yalnız özetleri gider. Açık değerler
 * yalnız oluşturma işleminin dönüşünde (bir kez) ekrana verilir; log'a, URL'ye yazılmaz.
 */
import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { pgErrorInfo } from "@/db/pg-error";
import { API_LIMITS, type ApiClientStatus, type ApiKeyStatus } from "@/lib/api-meta";
import { AppError } from "@/lib/errors";
import { generateAccessCode, generateApiKey } from "@/server/api/keys";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const d = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));

export const ADMIN_API_ERRORS = {
  not_found: "Kayıt bulunamadı.",
  name_invalid: `Acente adı 1-${API_LIMITS.clientNameMax} karakter olmalı.`,
  label_invalid: `Anahtar etiketi en fazla ${API_LIMITS.keyLabelMax} karakter olabilir.`,
  limit: `Bir hesapta en fazla ${API_LIMITS.activeKeysPerClient} etkin anahtar olabilir. Önce kullanılmayan bir anahtarı geri alın.`,
  disabled: "Pasif hesap için erişim kodu oluşturulamaz. Önce hesabı etkinleştirin.",
  exists: "Bu villa için bu acenteye zaten etkin izin var.",
  property_invalid: "Villa seçin.",
  confirm_required: "Onay kutusunu işaretleyin.",
  error: "İşlem tamamlanamadı. Yeniden deneyin.",
} as const;
export type AdminApiErrorCode = keyof typeof ADMIN_API_ERRORS;

export class AdminApiError extends AppError {
  constructor(readonly reason: AdminApiErrorCode) {
    super(reason === "not_found" ? "NOT_FOUND" : "CONFLICT", ADMIN_API_ERRORS[reason]);
  }
}

async function scalar(db: Database, query: ReturnType<typeof sql>): Promise<string | undefined> {
  try {
    const res = await db.execute<{ out: string }>(query);
    return res.rows[0]?.out;
  } catch (err) {
    if (pgErrorInfo(err).code === "23514") throw new AdminApiError("error");
    throw err;
  }
}

function outcomeOf(out: string | undefined, ok: readonly string[]): string {
  if (out && ok.includes(out)) return out;
  const reason = (out && out in ADMIN_API_ERRORS ? out : "error") as AdminApiErrorCode;
  throw new AdminApiError(reason);
}

export type AdminApiClientRow = {
  id: string;
  name: string;
  status: ApiClientStatus;
  createdAt: Date;
  activeKeys: number;
  activeGrants: number;
  requests30d: number;
  lastUsedAt: Date | null;
};

export async function listApiClients(db: Database, adminId: string): Promise<AdminApiClientRow[]> {
  const res = await db.execute<{
    id: string;
    name: string;
    status: ApiClientStatus;
    created_at: Date | string;
    active_keys: number;
    active_grants: number;
    requests_30d: string | number;
    last_used_at: Date | string | null;
  }>(sql`select * from public.app_api_admin_clients(${adminId}::uuid)`);
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    createdAt: new Date(r.created_at),
    activeKeys: Number(r.active_keys),
    activeGrants: Number(r.active_grants),
    requests30d: Number(r.requests_30d),
    lastUsedAt: d(r.last_used_at),
  }));
}

export type AdminApiClient = {
  id: string;
  name: string;
  status: ApiClientStatus;
  rateLimitPerMinute: number;
  accessCodeHint: string | null;
  accessCodeCreatedAt: Date | null;
  createdAt: Date;
};

export async function getApiClient(
  db: Database,
  adminId: string,
  clientId: string,
): Promise<AdminApiClient> {
  if (!isUuid(clientId)) throw new AdminApiError("not_found");
  const res = await db.execute<{
    id: string;
    name: string;
    status: ApiClientStatus;
    rate_limit_per_minute: number;
    access_code_hint: string | null;
    access_code_created_at: Date | string | null;
    created_at: Date | string;
  }>(sql`select * from public.app_api_admin_client(${adminId}::uuid, ${clientId}::uuid)`);
  const r = res.rows[0];
  if (!r) throw new AdminApiError("not_found");
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    rateLimitPerMinute: Number(r.rate_limit_per_minute),
    accessCodeHint: r.access_code_hint,
    accessCodeCreatedAt: d(r.access_code_created_at),
    createdAt: new Date(r.created_at),
  };
}

export async function createApiClient(
  db: Database,
  adminId: string,
  rawName: string,
): Promise<string> {
  const name = rawName.trim();
  if (name.length < 1 || name.length > API_LIMITS.clientNameMax) {
    throw new AdminApiError("name_invalid");
  }
  const id = await scalar(
    db,
    sql`select public.app_api_admin_create_client(${adminId}::uuid, ${name}) as out`,
  );
  if (!id) throw new AdminApiError("error");
  return id;
}

export async function setApiClientActive(
  db: Database,
  adminId: string,
  clientId: string,
  active: boolean,
): Promise<"updated" | "unchanged"> {
  if (!isUuid(clientId)) throw new AdminApiError("not_found");
  const out = await scalar(
    db,
    sql`select public.app_api_admin_set_client_status(${adminId}::uuid, ${clientId}::uuid, ${active}) as out`,
  );
  return outcomeOf(out, ["updated", "unchanged"]) as "updated" | "unchanged";
}

export type AdminApiKey = {
  id: string;
  prefix: string;
  label: string | null;
  status: ApiKeyStatus;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

export async function listApiKeys(
  db: Database,
  adminId: string,
  clientId: string,
): Promise<AdminApiKey[]> {
  if (!isUuid(clientId)) return [];
  const res = await db.execute<{
    id: string;
    prefix: string;
    label: string | null;
    status: ApiKeyStatus;
    created_at: Date | string;
    last_used_at: Date | string | null;
    revoked_at: Date | string | null;
  }>(sql`select * from public.app_api_admin_keys(${adminId}::uuid, ${clientId}::uuid)`);
  return res.rows.map((r) => ({
    id: r.id,
    prefix: r.prefix,
    label: r.label,
    status: r.status,
    createdAt: new Date(r.created_at),
    lastUsedAt: d(r.last_used_at),
    revokedAt: d(r.revoked_at),
  }));
}

/** Yeni anahtar. Dönen anahtar YALNIZ BİR KEZ gösterilir; saklanmaz. */
export async function createApiKey(
  db: Database,
  adminId: string,
  clientId: string,
  rawLabel: string,
): Promise<{ key: string; prefix: string }> {
  if (!isUuid(clientId)) throw new AdminApiError("not_found");
  const label = rawLabel.trim();
  if (label.length > API_LIMITS.keyLabelMax) throw new AdminApiError("label_invalid");
  // Önek/özet çakışması (pratikte imkânsız) olursa bir kez yeniden üretilir.
  for (let attempt = 0; attempt < 2; attempt++) {
    const k = generateApiKey();
    const out = await scalar(
      db,
      sql`select public.app_api_admin_create_key(${adminId}::uuid, ${clientId}::uuid, ${k.prefix}, ${k.hash}, ${label || null}) as out`,
    );
    if (out === "collision") continue;
    outcomeOf(out, ["created"]);
    return { key: k.key, prefix: k.prefix };
  }
  throw new AdminApiError("error");
}

export async function revokeApiKey(db: Database, adminId: string, keyId: string): Promise<void> {
  if (!isUuid(keyId)) throw new AdminApiError("not_found");
  const out = await scalar(
    db,
    sql`select public.app_api_admin_revoke_key(${adminId}::uuid, ${keyId}::uuid) as out`,
  );
  outcomeOf(out, ["revoked"]);
}

/** Yeni erişim kodu (öncekini geçersiz kılar). Dönen kod YALNIZ BİR KEZ gösterilir. */
export async function createAccessCode(
  db: Database,
  adminId: string,
  clientId: string,
): Promise<string> {
  if (!isUuid(clientId)) throw new AdminApiError("not_found");
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = generateAccessCode();
    const out = await scalar(
      db,
      sql`select public.app_api_admin_set_access_code(${adminId}::uuid, ${clientId}::uuid, ${c.hash}, ${c.hint}) as out`,
    );
    if (out === "collision") continue;
    outcomeOf(out, ["set"]);
    return c.code;
  }
  throw new AdminApiError("error");
}

export type AdminApiGrant = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  propertyId: string;
  propertyName: string;
  propertyActive: boolean;
  status: "active" | "revoked";
  grantedVia: "owner" | "admin";
  createdAt: Date;
  revokedAt: Date | null;
};

export async function listApiGrants(
  db: Database,
  adminId: string,
  clientId: string,
): Promise<AdminApiGrant[]> {
  if (!isUuid(clientId)) return [];
  const res = await db.execute<{
    id: string;
    workspace_id: string;
    workspace_name: string;
    property_id: string;
    property_name: string;
    property_active: boolean;
    status: "active" | "revoked";
    granted_via: "owner" | "admin";
    created_at: Date | string;
    revoked_at: Date | string | null;
  }>(sql`select * from public.app_api_admin_grants(${adminId}::uuid, ${clientId}::uuid)`);
  return res.rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    propertyId: r.property_id,
    propertyName: r.property_name,
    propertyActive: r.property_active,
    status: r.status,
    grantedVia: r.granted_via,
    createdAt: new Date(r.created_at),
    revokedAt: d(r.revoked_at),
  }));
}

export async function grantApiAccess(
  db: Database,
  adminId: string,
  clientId: string,
  propertyId: string,
): Promise<void> {
  if (!isUuid(clientId)) throw new AdminApiError("not_found");
  if (!isUuid(propertyId)) throw new AdminApiError("property_invalid");
  const out = await scalar(
    db,
    sql`select public.app_api_admin_grant(${adminId}::uuid, ${clientId}::uuid, ${propertyId}::uuid) as out`,
  );
  outcomeOf(out, ["granted"]);
}

export async function revokeApiAccess(
  db: Database,
  adminId: string,
  grantId: string,
): Promise<void> {
  if (!isUuid(grantId)) throw new AdminApiError("not_found");
  const out = await scalar(
    db,
    sql`select public.app_api_admin_revoke_grant(${adminId}::uuid, ${grantId}::uuid) as out`,
  );
  outcomeOf(out, ["revoked"]);
}

export type AdminApiUsageDay = {
  day: string;
  requests: number;
  rateLimited: number;
  errors: number;
};

export async function listApiUsage(
  db: Database,
  adminId: string,
  clientId: string,
): Promise<AdminApiUsageDay[]> {
  if (!isUuid(clientId)) return [];
  const res = await db.execute<{
    day: string;
    requests: number;
    rate_limited: number;
    errors: number;
  }>(sql`select * from public.app_api_admin_usage(${adminId}::uuid, ${clientId}::uuid)`);
  return res.rows.map((r) => ({
    day: r.day,
    requests: Number(r.requests),
    rateLimited: Number(r.rate_limited),
    errors: Number(r.errors),
  }));
}
