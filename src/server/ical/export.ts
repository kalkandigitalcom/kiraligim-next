/**
 * Dışa aktarma akışı (oturumsuz, belirteçli). Yalnız SECURITY DEFINER app_ical_export okunur:
 * belirteç geçerliyse mülkün beklemede + onaylı rezervasyonları ve blokları (iptal hariç) döner;
 * harici (içe aktarılmış) olaylar fonksiyonda hiç okunmaz → senkron döngüsü oluşamaz.
 * Akışta misafir adı, telefon, e-posta, tutar ve not yoktur (buildIcsFeed sabit özet yazar).
 */
import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { buildIcsFeed, type ExportEvent } from "@/lib/ical";
import { ICAL_TOKEN_RE } from "@/lib/ical-meta";

type AnyDb = Database;

type Row = {
  calendar_name: string;
  uid: string | null;
  check_in: string | null;
  check_out: string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
};

export async function buildExportFeed(
  db: AnyDb,
  token: string,
  now: Date = new Date(),
): Promise<{ ok: true; ics: string } | { ok: false }> {
  if (!ICAL_TOKEN_RE.test(token)) return { ok: false };
  const res = await db.execute<Row>(sql`select * from app_ical_export(${token})`);
  if (res.rows.length === 0) return { ok: false };
  const name = res.rows[0]!.calendar_name;
  const events: ExportEvent[] = res.rows.flatMap((r) =>
    r.uid && r.check_in && r.check_out && r.created_at && r.updated_at
      ? [
          {
            id: r.uid,
            checkIn: r.check_in,
            checkOut: r.check_out,
            createdAt: new Date(r.created_at),
            updatedAt: new Date(r.updated_at),
          },
        ]
      : [],
  );
  return { ok: true, ics: buildIcsFeed({ calendarName: `${name} – Kiralığım`, events, now }) };
}
