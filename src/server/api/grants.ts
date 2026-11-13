/**
 * İşletme paneli — villa sayfasında "API erişimi" (salt okunur). Yalnız withTenant bağlamında ve
 * veritabanı fonksiyonları (drizzle/0052, 0056) üzerinden: işletme oturumdan gelir; villa kimliği
 * yetki vermez (fonksiyon villanın o işletmeye ait olduğunu yeniden denetler).
 *
 * İzinleri yalnız Super Admin ekler ve kaldırır (src/server/admin/api-clients.ts); işletme tarafı
 * mevcut izinleri ve takvim bağlantılarını yalnız görür.
 */
import { sql } from "drizzle-orm";

import type { Tx } from "@/db/tenant";

import { isUuid } from "./http";

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
