/**
 * Acente API'si — veritabanı erişimi. Yalnız SECURITY DEFINER fonksiyonlar (drizzle/0052) çağrılır;
 * tablolar doğrudan okunmaz. Fonksiyonlara anahtarın kendisi değil, yalnız SHA-256 özeti gider.
 * Her fonksiyon anahtarı, hesabın durumunu ve villa iznini yeniden denetler.
 */
import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { pgErrorInfo } from "@/db/pg-error";

/** Uygulama (app_user) bağlantısı. */
type Db = Database;

export type BeginResult =
  | { outcome: "unauthorized" }
  | { outcome: "account_disabled" }
  | {
      outcome: "ok" | "rate_limited";
      client: { id: string; name: string };
      limit: number;
      remaining: number;
      resetAt: Date;
    };

type BeginRow = {
  outcome: "ok" | "unauthorized" | "account_disabled" | "rate_limited";
  client_id: string | null;
  client_name: string | null;
  rate_limit: number | null;
  remaining: number | null;
  reset_at: Date | string | null;
};

/** Kimlik doğrulama + dakikalık sınır + günlük kullanım: her istekte tek çağrı. */
export async function beginRequest(db: Db, keyHash: string): Promise<BeginResult> {
  const res = await db.execute<BeginRow>(sql`select * from public.app_api_begin(${keyHash})`);
  const r = res.rows[0];
  if (!r || r.outcome === "unauthorized" || r.outcome === "account_disabled") {
    return r?.outcome === "account_disabled"
      ? { outcome: "account_disabled" }
      : { outcome: "unauthorized" };
  }
  return {
    outcome: r.outcome,
    client: { id: r.client_id!, name: r.client_name! },
    limit: Number(r.rate_limit),
    remaining: Number(r.remaining),
    resetAt: new Date(r.reset_at!),
  };
}

/** 4xx yanıtlarını hesabın günlük hata sayısına işler (başarısızlık isteği bozmaz). */
export async function noteError(db: Db, keyHash: string): Promise<void> {
  await db.execute(sql`select public.app_api_note_error(${keyHash})`);
}

export type ApiProperty = { id: string; name: string };

/** Anahtar arada geri alındı / hesap pasifleşti (28000). */
export class ApiUnauthorized extends Error {}
/** Villa izinli değil, başka acenteye ait veya yok (P0002). */
export class ApiNotFound extends Error {}
/** Geçersiz tarih penceresi (22023). */
export class ApiInvalid extends Error {}

function mapError(err: unknown): never {
  const { code } = pgErrorInfo(err);
  if (code === "28000") throw new ApiUnauthorized();
  if (code === "P0002") throw new ApiNotFound();
  if (code === "22023") throw new ApiInvalid();
  throw err;
}

export async function listProperties(
  db: Db,
  keyHash: string,
  opts: { after: string | null; limit: number },
): Promise<ApiProperty[]> {
  try {
    const res = await db.execute<ApiProperty>(
      sql`select id, name from public.app_api_properties(${keyHash}, ${opts.after}::uuid, ${opts.limit}::integer)`,
    );
    return res.rows.map((r) => ({ id: r.id, name: r.name }));
  } catch (err) {
    mapError(err);
  }
}

export async function getProperty(
  db: Db,
  keyHash: string,
  propertyId: string,
): Promise<ApiProperty | null> {
  try {
    const res = await db.execute<ApiProperty>(
      sql`select id, name from public.app_api_property(${keyHash}, ${propertyId}::uuid)`,
    );
    const r = res.rows[0];
    return r ? { id: r.id, name: r.name } : null;
  } catch (err) {
    mapError(err);
  }
}

export type BusyRange = { start_date: string; end_date: string };

/** Dolu aralıklar [start_date, end_date) — çıkış günü dahil değildir. */
export async function getBusyRanges(
  db: Db,
  keyHash: string,
  propertyId: string,
  window: { from: string; to: string },
): Promise<BusyRange[]> {
  try {
    const res = await db.execute<BusyRange>(
      sql`select start_date, end_date from public.app_api_busy(${keyHash}, ${propertyId}::uuid, ${window.from}::date, ${window.to}::date)`,
    );
    return res.rows.map((r) => ({ start_date: r.start_date, end_date: r.end_date }));
  } catch (err) {
    mapError(err);
  }
}
