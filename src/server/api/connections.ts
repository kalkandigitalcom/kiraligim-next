/**
 * Acente API'si 2. aşama — takvim bağlantıları (drizzle/0055, 0056).
 *
 * Yalnız SECURITY DEFINER fonksiyonlar çağrılır; fonksiyonlara anahtarın kendisi değil özeti
 * gider. Hesap anahtardan bulunur; bağlantı ve villa kimlikleri yetki vermez (başka acentenin
 * bağlantısı / izinsiz villa = bulunamadı). Yanıt alanları aşağıda açıkça kurulur.
 */
import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { pgErrorInfo } from "@/db/pg-error";
import type { ApiConnectionViewStatus } from "@/lib/api-meta";

import { ApiInvalid, ApiUnauthorized } from "./service";

export type ApiConnection = {
  id: string;
  property_id: string;
  external_property_id: string;
  /** active | paused (villa/işletme/izin etkin değil; saklanmaz) | disconnected | revoked */
  status: ApiConnectionViewStatus;
  created_at: string;
  ended_at: string | null;
  last_synced_at: string | null;
};

type Row = {
  id: string;
  property_id: string;
  external_property_id: string;
  status: ApiConnectionViewStatus;
  created_at: Date | string;
  ended_at: Date | string | null;
  last_synced_at: Date | string | null;
};

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());

/** Veritabanı satırından yalnız tanımlı alanlar. */
export function toApiConnection(r: Row): ApiConnection {
  return {
    id: r.id,
    property_id: r.property_id,
    external_property_id: r.external_property_id,
    status: r.status,
    created_at: iso(r.created_at)!,
    ended_at: iso(r.ended_at),
    last_synced_at: iso(r.last_synced_at),
  };
}

function mapError(err: unknown): never {
  const { code } = pgErrorInfo(err);
  if (code === "28000") throw new ApiUnauthorized();
  if (code === "22023") throw new ApiInvalid();
  throw err;
}

export type ConnectOutcome =
  | { outcome: "created" | "exists"; connection: ApiConnection }
  | { outcome: "already_connected" | "external_id_in_use" | "not_found" };

export async function connectProperty(
  db: Database,
  keyHash: string,
  input: { propertyId: string; externalPropertyId: string },
): Promise<ConnectOutcome> {
  try {
    const res = await db.execute<Row & { outcome: ConnectOutcome["outcome"] }>(
      sql`select * from public.app_api_connect(${keyHash}, ${input.propertyId}::uuid, ${input.externalPropertyId})`,
    );
    const r = res.rows[0];
    if (!r) return { outcome: "not_found" };
    if (r.outcome === "created" || r.outcome === "exists") {
      return { outcome: r.outcome, connection: toApiConnection(r) };
    }
    return { outcome: r.outcome };
  } catch (err) {
    mapError(err);
  }
}

export async function listConnections(
  db: Database,
  keyHash: string,
  opts: { after: string | null; limit: number; all: boolean },
): Promise<ApiConnection[]> {
  try {
    const res = await db.execute<Row>(
      sql`select * from public.app_api_connections(${keyHash}, ${opts.after}::uuid, ${opts.limit}::integer, ${opts.all})`,
    );
    return res.rows.map(toApiConnection);
  } catch (err) {
    mapError(err);
  }
}

export async function getConnection(
  db: Database,
  keyHash: string,
  id: string,
): Promise<ApiConnection | null> {
  try {
    const res = await db.execute<Row>(
      sql`select * from public.app_api_connection(${keyHash}, ${id}::uuid)`,
    );
    const r = res.rows[0];
    return r ? toApiConnection(r) : null;
  } catch (err) {
    mapError(err);
  }
}

export async function disconnect(
  db: Database,
  keyHash: string,
  id: string,
): Promise<{ outcome: "disconnected" | "ended"; connection: ApiConnection } | null> {
  try {
    const res = await db.execute<Row & { outcome: "disconnected" | "ended" | "not_found" }>(
      sql`select * from public.app_api_disconnect(${keyHash}, ${id}::uuid)`,
    );
    const r = res.rows[0];
    if (!r || r.outcome === "not_found" || !r.id) return null;
    return { outcome: r.outcome, connection: toApiConnection(r) };
  } catch (err) {
    mapError(err);
  }
}

// ---------------------------------------------------------------------------------------------
// 3. adım — snapshot ve cursor
// ---------------------------------------------------------------------------------------------

export type BusyRange = { start_date: string; end_date: string };

export type ApiSnapshot = {
  connection_id: string;
  property_id: string;
  external_property_id: string;
  from: string;
  to: string;
  /** [start_date, end_date) — end_date çıkış günüdür, dolu değildir. */
  busy_dates: BusyRange[];
  cursor: string;
};

const busyOf = (v: unknown): BusyRange[] =>
  Array.isArray(v)
    ? v.map((b: { start_date: string; end_date: string }) => ({
        start_date: b.start_date,
        end_date: b.end_date,
      }))
    : [];

/**
 * İlk (ya da yeniden) senkronizasyon: cursor ve dolu aralıklar aynı veri anından (drizzle/0058).
 * Etkin bağlantı yoksa (başka acentenin, paused, bitmiş) null.
 */
export async function takeSnapshot(
  db: Database,
  keyHash: string,
  connectionId: string,
): Promise<ApiSnapshot | null> {
  try {
    const res = await db.execute<{
      connection_id: string;
      property_id: string;
      external_property_id: string;
      from_date: string;
      to_date: string;
      busy: unknown;
      cursor: string;
    }>(sql`select * from public.app_api_snapshot(${keyHash}, ${connectionId}::uuid)`);
    const r = res.rows[0];
    if (!r) return null;
    return {
      connection_id: r.connection_id,
      property_id: r.property_id,
      external_property_id: r.external_property_id,
      from: r.from_date,
      to: r.to_date,
      busy_dates: busyOf(r.busy),
      cursor: r.cursor,
    };
  } catch (err) {
    mapError(err);
  }
}

export type ApiChange = {
  change_id: string;
  /** Değişen aralık [start_date, end_date). */
  start_date: string;
  end_date: string;
  /** Aralık içindeki dolu bölümler; aralığın kalanı boştur (yerine koyma). */
  busy_dates: BusyRange[];
};

export type ChangesResult =
  | {
      outcome: "ok";
      body: {
        connection_id: string;
        property_id: string;
        external_property_id: string;
        changes: ApiChange[];
        next_cursor: string;
        has_more: boolean;
      };
    }
  | { outcome: "not_found" | "invalid_cursor" | "cursor_expired" };

export async function readChanges(
  db: Database,
  keyHash: string,
  connectionId: string,
  opts: { cursor: string; limit: number },
): Promise<ChangesResult> {
  try {
    const res = await db.execute<{
      outcome: "ok" | "not_found" | "invalid_cursor" | "cursor_expired";
      connection_id: string | null;
      property_id: string | null;
      external_property_id: string | null;
      changes: unknown;
      next_cursor: string | null;
      has_more: boolean | null;
    }>(
      sql`select * from public.app_api_changes(${keyHash}, ${connectionId}::uuid, ${opts.cursor}, ${opts.limit}::integer)`,
    );
    const r = res.rows[0];
    if (!r) return { outcome: "not_found" };
    if (r.outcome !== "ok") return { outcome: r.outcome };
    const changes = Array.isArray(r.changes)
      ? (r.changes as ApiChange[]).map((c) => ({
          change_id: c.change_id,
          start_date: c.start_date,
          end_date: c.end_date,
          busy_dates: busyOf(c.busy_dates),
        }))
      : [];
    return {
      outcome: "ok",
      body: {
        connection_id: r.connection_id!,
        property_id: r.property_id!,
        external_property_id: r.external_property_id!,
        changes,
        next_cursor: r.next_cursor!,
        has_more: r.has_more === true,
      },
    };
  } catch (err) {
    mapError(err);
  }
}

// ---------------------------------------------------------------------------------------------
// 5. adım — hesap geneli değişiklik akışı
// ---------------------------------------------------------------------------------------------

export type ApiAccountChange = ApiChange & {
  connection_id: string;
  property_id: string;
  external_property_id: string;
};

export type AccountChangesResult =
  | {
      outcome: "ok";
      body: { changes: ApiAccountChange[]; next_cursor: string; has_more: boolean };
    }
  | { outcome: "invalid_cursor" | "cursor_expired" };

/**
 * Hesabın etkin ve snapshot alınmış bağlantılarındaki değişiklikler (drizzle/0061). Cursor hesaba
 * özeldir ("a1."); cursor verilmezse şimdiki konumdan başlar (boş liste + cursor).
 */
export async function readAccountChanges(
  db: Database,
  keyHash: string,
  opts: { cursor: string | null; limit: number },
): Promise<AccountChangesResult> {
  try {
    const res = await db.execute<{
      outcome: "ok" | "invalid_cursor" | "cursor_expired";
      changes: unknown;
      next_cursor: string | null;
      has_more: boolean | null;
    }>(
      sql`select * from public.app_api_account_changes(${keyHash}, ${opts.cursor}, ${opts.limit}::integer)`,
    );
    const r = res.rows[0]!;
    if (r.outcome !== "ok") return { outcome: r.outcome };
    const changes = Array.isArray(r.changes)
      ? (r.changes as ApiAccountChange[]).map((c) => ({
          change_id: c.change_id,
          connection_id: c.connection_id,
          property_id: c.property_id,
          external_property_id: c.external_property_id,
          start_date: c.start_date,
          end_date: c.end_date,
          busy_dates: busyOf(c.busy_dates),
        }))
      : [];
    return {
      outcome: "ok",
      body: { changes, next_cursor: r.next_cursor!, has_more: r.has_more === true },
    };
  } catch (err) {
    mapError(err);
  }
}
