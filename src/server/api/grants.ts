/**
 * İşletme paneli — villa sayfasında "API erişimi" (1. aşama). Yalnız withTenant bağlamında ve
 * veritabanı fonksiyonları (drizzle/0052) üzerinden: işletme ve kullanıcı oturumdan gelir; villa
 * kimliği yetki vermez (fonksiyon villanın o işletmeye ait olduğunu ve rolün owner/manager
 * olduğunu yeniden denetler). Erişim kodu veritabanına yalnız özetiyle gider.
 *
 * Akış: kod girilir → acente adı gösterilir → ev sahibi onaylar → izin oluşur. Onay adımında kod
 * yeniden doğrulanır; arada kod yenilenmişse izin oluşmaz.
 */
import { sql } from "drizzle-orm";

import type { MemberRole, Tx } from "@/db/tenant";

import { isUuid } from "./http";
import { accessCodeHashFromInput } from "./keys";

export const canManageApiAccess = (role: MemberRole) => role === "owner" || role === "manager";

export type PropertyApiGrant = {
  id: string;
  clientName: string;
  grantedVia: "owner" | "admin";
  createdAt: Date;
};

export async function listPropertyApiGrants(
  tx: Tx,
  propertyId: string,
): Promise<PropertyApiGrant[]> {
  if (!isUuid(propertyId)) return [];
  const res = await tx.execute<{
    id: string;
    client_name: string;
    granted_via: "owner" | "admin";
    created_at: Date | string;
  }>(sql`select * from public.app_api_property_grants(${propertyId}::uuid)`);
  return res.rows.map((r) => ({
    id: r.id,
    clientName: r.client_name,
    grantedVia: r.granted_via,
    createdAt: new Date(r.created_at),
  }));
}

export type CodeLookup =
  | { ok: true; client: { id: string; name: string } }
  | { ok: false; reason: "format" | "invalid_code" };

/** Kodu doğrular ve acente adını döndürür (izin OLUŞTURMAZ). */
export async function lookupAccessCode(tx: Tx, input: string): Promise<CodeLookup> {
  const hash = accessCodeHashFromInput(input);
  if (!hash) return { ok: false, reason: "format" };
  const res = await tx.execute<{ client_id: string; name: string }>(
    sql`select * from public.app_api_lookup_access_code(${hash})`,
  );
  const r = res.rows[0];
  return r
    ? { ok: true, client: { id: r.client_id, name: r.name } }
    : { ok: false, reason: "invalid_code" };
}

export type GrantOutcome = "granted" | "exists" | "invalid_code" | "not_found";

/** Ev sahibinin onayı: kod hâlâ gösterilen acenteye aitse izin oluşturulur. */
export async function grantPropertyAccess(
  tx: Tx,
  input: { propertyId: string; code: string; clientId: string },
): Promise<GrantOutcome> {
  if (!isUuid(input.propertyId)) return "not_found";
  const hash = accessCodeHashFromInput(input.code);
  if (!hash || !isUuid(input.clientId)) return "invalid_code";
  const res = await tx.execute<{ out: GrantOutcome }>(
    sql`select public.app_api_grant_property(${input.propertyId}::uuid, ${hash}, ${input.clientId}::uuid) as out`,
  );
  return res.rows[0]?.out ?? "not_found";
}

export async function revokePropertyAccess(
  tx: Tx,
  grantId: string,
): Promise<"revoked" | "not_found"> {
  if (!isUuid(grantId)) return "not_found";
  const res = await tx.execute<{ out: "revoked" | "not_found" }>(
    sql`select public.app_api_revoke_property_grant(${grantId}::uuid) as out`,
  );
  return res.rows[0]?.out ?? "not_found";
}

export type PropertyApiConnection = {
  id: string;
  grantId: string;
  clientName: string;
  /** Villa pasif veya acente hesabı pasif: bağlantı kayıtlı ama senkron duraklatılmış. */
  paused: boolean;
  createdAt: Date;
  lastSyncedAt: Date | null;
};

/** Villanın etkin takvim bağlantıları (acentenin kendi villa kimliği gösterilmez). */
export async function listPropertyApiConnections(
  tx: Tx,
  propertyId: string,
): Promise<PropertyApiConnection[]> {
  if (!isUuid(propertyId)) return [];
  const res = await tx.execute<{
    id: string;
    grant_id: string;
    client_name: string;
    paused: boolean;
    created_at: Date | string;
    last_synced_at: Date | string | null;
  }>(sql`select * from public.app_api_property_connections(${propertyId}::uuid)`);
  return res.rows.map((r) => ({
    id: r.id,
    grantId: r.grant_id,
    clientName: r.client_name,
    paused: r.paused,
    createdAt: new Date(r.created_at),
    lastSyncedAt: r.last_synced_at === null ? null : new Date(r.last_synced_at),
  }));
}
