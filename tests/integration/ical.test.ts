import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import { pgErrorInfo } from "@/db/pg-error";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { parseIcs } from "@/lib/ical";
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import { buildExportFeed } from "@/server/ical/export";
import type { FetchIcsResult } from "@/server/ical/fetch";
import {
  addSource,
  deleteSource,
  ensureExport,
  findExternalConflicts,
  listExternalBlocks,
  listRecentRuns,
  listSources,
  rotateExport,
  setSourceActive,
  updateSource,
} from "@/server/ical/service";
import { claimSource, runDueSync, syncClaimed } from "@/server/ical/sync";
import { photoPrefix } from "@/server/properties/photos";
import { publishProperty, updatePublicSlug } from "@/server/properties/public-profile";
import { createProperty } from "@/server/properties/service";
import { submitReservationRequest } from "@/server/public/reservation-request";
import { getPublicVilla } from "@/server/public/villa";
import {
  cancelReservation,
  confirmReservation,
  createReservation,
  updateReservation,
} from "@/server/reservations/service";
import { updateWorkspaceWhatsapp } from "@/server/workspaces/contact";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

/**
 * Aşama 3.1: iki yönlü iCal (drizzle/0028, 0029) — gerçek PostgreSQL, app_user, RLS.
 * Ağ yoktur: indirici sahte (adres → ICS metni / hata); SSRF ve HTTP yolu birim testlerindedir.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 8 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const T = istanbulToday();
const d = (n: number) => addDays(T, n);
const ics = (iso: string) => iso.replace(/-/g, "");

type U = { id: string; email: string };
const mkUser = async (label: string): Promise<U> => {
  const u = { id: uuidv7(), email: `${label}.${tag}@ornek.com` };
  await admin.query(
    "insert into users (id, name, email, email_verified) values ($1, $2, $3, true)",
    [u.id, `${label} K`, u.email],
  );
  return u;
};
const as = <R>(u: U, ws: string, fn: (tx: Tx, ctx: TenantContext) => Promise<R>) =>
  withTenant(app, { userId: u.id, workspaceId: ws }, fn);

/** Sahte akışlar: adres → ICS metni veya indirme hatası. */
const feeds = new Map<string, string | FetchIcsResult>();
const fetcher = async (url: string): Promise<FetchIcsResult> => {
  const v = feeds.get(url);
  if (v === undefined) return { ok: false, code: "http_status" };
  return typeof v === "string" ? { ok: true, text: v } : v;
};
const deps = { fetcher, today: () => T };

const calendar = (...events: { uid: string; from: number; to: number; extra?: string[] }[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//TR",
    ...events.flatMap((e) => [
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      "SUMMARY:Ayşe Yılmaz rezervasyonu",
      `DTSTART;VALUE=DATE:${ics(d(e.from))}`,
      `DTEND;VALUE=DATE:${ics(d(e.to))}`,
      ...(e.extra ?? []),
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join("\r\n");

/** Panel yolu: kilit (RLS ile doğrulanmış kaynak) → indir/ayrıştır → uygula. */
async function manualSync(u: U, ws: string, sourceId: string) {
  const c = await as(u, ws, (tx) => claimSource(tx, sourceId));
  if (!c.claim) return c.outcome;
  return syncClaimed(app, c.claim, "manual", deps);
}

/** Senkron aralığı beklemeden yeniden senkron edebilmek için son denemeyi geriye al. */
const age = (sourceId: string) =>
  admin.query(
    "update external_calendar_sources set last_synced_at = now() - interval '5 hours' where id = $1",
    [sourceId],
  );

const events = async (sourceId: string) =>
  (
    await admin.query(
      `select uid, start_date::text s, end_date::text e, is_active a from external_calendar_events
        where source_id = $1 order by uid`,
      [sourceId],
    )
  ).rows as { uid: string; s: string; e: string; a: boolean }[];

const guest = (over: Record<string, unknown> = {}) => ({
  kind: "reservation",
  guestName: "Mehmet Kaya",
  guestPhone: "+90 532 123 45 67",
  guestEmail: "mehmet@ornek.com",
  adults: "2",
  children: "0",
  source: "direct",
  ...over,
});

async function villa(owner: U, ws: string, name: string) {
  return as(owner, ws, (tx, ctx) =>
    createProperty(tx, ctx, {
      name,
      propertyType: "villa",
      maxGuests: "6",
      bedrooms: "3",
      bathrooms: "2",
      province: "Antalya",
      district: "Kaş",
    }),
  );
}

/** Kaynak kimlikleri ada göre (ilk testlerde doldurulur). */
const srcIds = new Map<string, string>();
const srcOf = (name: string) => srcIds.get(name)!;

let O: U, M: U, S: U, X: U;
let ws: string, wsX: string, prop: string, prop2: string, propX: string;
const URL_A = `https://www.airbnb.example/calendar/ical/${tag}.ics?s=gizli1`;
const URL_B = `https://admin.booking.example/hotel/ical/${tag}.ics?t=gizli2`;

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("icowner");
  M = await mkUser("icmanager");
  S = await mkUser("icstaff");
  X = await mkUser("icother");
  ws = (await createWorkspace(app, { userId: O.id, name: "iCal İşletme", slug: `ic-${tag}` })).id;
  // Varsayılan plan tek mülk; bu işletmeye çok mülklü test planı.
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'iCal test', 20, 14, true, false)",
    [planId, `ical_${tag}`],
  );
  await admin.query("update workspace_subscriptions set plan_id = $1 where workspace_id = $2", [
    planId,
    ws,
  ]);
  wsX = (await createWorkspace(app, { userId: X.id, name: "Diğer", slug: `icx-${tag}` })).id;
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
  prop = await villa(O, ws, "Villa Defne");
  prop2 = await villa(O, ws, "Villa Lavanta");
  propX = await villa(X, wsX, "Başka Villa");
});

afterAll(async () => {
  // Test planını kaldır: plan kataloğu testleri (billing) yalnız varsayılan paketi bekler.
  await admin.query(
    "update workspace_subscriptions set plan_id = (select id from plans where is_default) where workspace_id = $1",
    [ws],
  );
  await admin.query("delete from plans where code = $1", [`ical_${tag}`]);
  await admin.end();
  await appPool.end();
});

describe("içe aktarma (import)", () => {
  let srcA: string;
  let srcB: string;

  it("1) geçerli iCal adresinden dolu tarihler aktarılır; özet/misafir bilgisi saklanmaz", async () => {
    feeds.set(
      URL_A,
      calendar({ uid: "a1@airbnb", from: 30, to: 35 }, { uid: "a2@airbnb", from: 50, to: 53 }),
    );
    srcA = await as(M, ws, (tx, ctx) =>
      addSource(tx, ctx, prop, { name: "Airbnb", url: URL_A, isActive: "on" }),
    );
    srcIds.set("Airbnb", srcA);
    const r = await manualSync(M, ws, srcA);
    expect(r).toMatchObject({ outcome: "ok", total: 2, added: 2, deactivated: 0 });
    expect(await events(srcA)).toEqual([
      { uid: "a1@airbnb", s: d(30), e: d(35), a: true },
      { uid: "a2@airbnb", s: d(50), e: d(53), a: true },
    ]);
    const cols = await admin.query(
      "select column_name from information_schema.columns where table_name = 'external_calendar_events'",
    );
    expect(cols.rows.map((c) => c.column_name)).not.toContain("summary");
    // Rezervasyon tablosuna sahte kayıt yazılmaz.
    const resv = await admin.query(
      "select count(*)::int n from reservations where property_id = $1",
      [prop],
    );
    expect(resv.rows[0].n).toBe(0);
    const [s] = await as(M, ws, (tx, ctx) => listSources(tx, ctx, prop));
    expect(s).toMatchObject({ status: "ok", eventCount: 2, url: URL_A, lastErrorCode: null });
    expect(s!.lastSuccessAt).toBeInstanceOf(Date);
  });

  it("2) aynı kaynağın tekrar senkronu kayıt çoğaltmaz; değişen tarih güncellenir, kalkan olay yalnız pasifleşir", async () => {
    await age(srcA);
    const again = await runDueSync(app, deps);
    expect(again).toMatchObject({ processed: 1, ok: 1, failed: 0 });
    expect(await events(srcA)).toHaveLength(2);
    feeds.set(URL_A, calendar({ uid: "a1@airbnb", from: 31, to: 35 }));
    await age(srcA);
    const r = await manualSync(M, ws, srcA);
    expect(r).toMatchObject({ outcome: "ok", total: 1, added: 0, updated: 1, deactivated: 1 });
    expect(await events(srcA)).toEqual([
      { uid: "a1@airbnb", s: d(31), e: d(35), a: true },
      { uid: "a2@airbnb", s: d(50), e: d(53), a: false },
    ]);
  });

  it("3–4) iki kaynak aynı tarihi kapatır; biri silinince diğerinin doluluğu sürer", async () => {
    feeds.set(URL_B, calendar({ uid: "b1@booking", from: 32, to: 40 }));
    srcB = await as(O, ws, (tx, ctx) =>
      addSource(tx, ctx, prop, { name: "Booking.com", url: URL_B, isActive: "on" }),
    );
    expect(await manualSync(O, ws, srcB)).toMatchObject({ outcome: "ok", added: 1 });
    const blocks = await as(S, ws, (tx) => listExternalBlocks(tx, prop, d(0), d(90)));
    expect(blocks.map((b) => [b.sourceName, b.checkIn, b.checkOut])).toEqual([
      ["Airbnb", d(31), d(35)],
      ["Booking.com", d(32), d(40)],
    ]);
    // Booking silinince yalnız onun olayları gider; Airbnb'nin 31–35'i hâlâ kapalı.
    await as(O, ws, (tx, ctx) => deleteSource(tx, ctx, srcB));
    expect(await events(srcB)).toEqual([]);
    const after = await as(O, ws, (tx) => findExternalConflicts(tx, prop, d(33), d(34)));
    expect(after.map((c) => c.sourceName)).toEqual(["Airbnb"]);
    expect(await as(O, ws, (tx) => findExternalConflicts(tx, prop, d(36), d(39)))).toEqual([]);
    // Yeniden eklemek için (sonraki testler).
    srcB = await as(O, ws, (tx, ctx) =>
      addSource(tx, ctx, prop, { name: "Booking.com", url: URL_B, isActive: "on" }),
    );
    await manualSync(O, ws, srcB);
  });

  it("11) başarısız kaynak diğerlerini durdurmaz; hata olayları silmez; kayıtlar tutulur", async () => {
    feeds.set(URL_B, { ok: false, code: "timeout" });
    await age(srcA);
    await age(srcB);
    const sum = await runDueSync(app, deps);
    expect(sum).toMatchObject({ processed: 2, ok: 1, failed: 1 });
    const list = await as(O, ws, (tx, ctx) => listSources(tx, ctx, prop));
    const b = list.find((s) => s.id === srcB)!;
    expect(b).toMatchObject({ status: "error", lastErrorCode: "timeout", consecutiveFailures: 1 });
    expect(list.find((s) => s.id === srcA)).toMatchObject({ status: "ok" });
    // Geçici hata tarihleri açmaz: Booking'in son başarılı olayları korunur.
    expect((await events(srcB)).every((e) => e.a)).toBe(true);
    const runs = await as(O, ws, (tx) => listRecentRuns(tx, prop));
    expect(runs.find((r) => r.sourceId === srcB)).toMatchObject({
      outcome: "error",
      errorCode: "timeout",
      trigger: "cron",
    });
    // Bozuk içerik de kontrollü hata.
    feeds.set(URL_B, "<html>giriş</html>");
    await age(srcB);
    expect(await manualSync(O, ws, srcB)).toEqual({ outcome: "error", code: "not_ical" });
    feeds.set(URL_B, calendar({ uid: "b1@booking", from: 32, to: 40 }));
    await age(srcB);
    expect(await manualSync(O, ws, srcB)).toMatchObject({ outcome: "ok" });
  });

  it("eşzamanlı senkron yok: kilit varken ikinci deneme 'locked', 60 sn içinde 'too_soon'", async () => {
    await age(srcA);
    const first = await as(O, ws, (tx) => claimSource(tx, srcA));
    expect(first.outcome).toBe("claimed");
    expect((await as(O, ws, (tx) => claimSource(tx, srcA))).outcome).toBe("locked");
    // Cron kilitli kaynağı almaz.
    expect(await runDueSync(app, deps)).toMatchObject({ processed: 0 });
    const r = await syncClaimed(app, first.claim!, "manual", deps);
    expect(r.outcome).toBe("ok");
    expect((await as(O, ws, (tx) => claimSource(tx, srcA))).outcome).toBe("too_soon");
    // Eski kilit belirteciyle sonuç yazılamaz.
    expect(await syncClaimed(app, first.claim!, "manual", deps)).toEqual({ outcome: "lock_lost" });
  });

  it("pasif kaynak tarihleri kapatmaz ve senkron edilmez; yeniden etkinleşince kapatır", async () => {
    await as(O, ws, (tx, ctx) => setSourceActive(tx, ctx, srcB, false));
    expect(await as(O, ws, (tx) => findExternalConflicts(tx, prop, d(36), d(39)))).toEqual([]);
    expect((await as(O, ws, (tx) => claimSource(tx, srcB))).outcome).toBe("inactive");
    await as(O, ws, (tx, ctx) => setSourceActive(tx, ctx, srcB, true));
    expect(
      (await as(O, ws, (tx) => findExternalConflicts(tx, prop, d(36), d(39)))).map(
        (c) => c.sourceName,
      ),
    ).toEqual(["Booking.com"]);
    const [b] = (await as(O, ws, (tx, ctx) => listSources(tx, ctx, prop))).filter(
      (s) => s.id === srcB,
    );
    // Yeniden etkinleşen kaynak bir sonraki cron'da hemen alınır.
    expect(b!.lastSyncedAt).toBeNull();
  });

  it("12) DTEND hariç: çıkış günü yeni girişe açıktır", async () => {
    // Airbnb 31–35: 35'te giriş serbest, 34'te değil.
    // 35–37 Booking 32–40 ile çakışır → reddedilir; Booking pasifken 35 girişi serbesttir.
    await expect(
      as(O, ws, (tx, ctx) =>
        createReservation(tx, ctx, guest({ propertyId: prop, checkIn: d(35), checkOut: d(37) })),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await as(O, ws, (tx, ctx) => setSourceActive(tx, ctx, srcB, false));
    const id = await as(O, ws, (tx, ctx) =>
      createReservation(tx, ctx, guest({ propertyId: prop, checkIn: d(35), checkOut: d(37) })),
    );
    expect(id).toBeTruthy();
    await as(O, ws, (tx, ctx) => cancelReservation(tx, ctx, id));
    await as(O, ws, (tx, ctx) => setSourceActive(tx, ctx, srcB, true));
    await age(srcB);
    await manualSync(O, ws, srcB);
  });
});

describe("5) müsaitlik: harici doluluk yeni kaydı engeller", () => {
  it("panel rezervasyonu ve blok engellenir; mesaj kaynak adını içerir; veritabanı da reddeder", async () => {
    await expect(
      as(O, ws, (tx, ctx) =>
        createReservation(tx, ctx, guest({ propertyId: prop, checkIn: d(33), checkOut: d(36) })),
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("harici takvim: Airbnb"),
    });
    await expect(
      as(O, ws, (tx, ctx) =>
        createReservation(tx, ctx, {
          kind: "block",
          propertyId: prop,
          checkIn: d(38),
          checkOut: d(39),
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Uygulamayı atlayan ham ekleme de 23P01 ile reddedilir.
    const err = await as(O, ws, (tx) =>
      tx.execute(sql`
        insert into reservations (id, workspace_id, property_id, kind, status, check_in, check_out, created_by)
        values (${uuidv7()}, ${ws}, ${prop}, 'block', 'confirmed', ${d(33)}::date, ${d(34)}::date,
                app_current_user_id())`),
    ).catch((e: unknown) => e);
    expect(pgErrorInfo(err)).toMatchObject({
      code: "23P01",
      message: "reservation_external_overlap",
    });
  });

  it("tarih değişikliği engellenir; başka mülk ve iptal edilmiş/pasif durumlar etkilenmez", async () => {
    const id = await as(O, ws, (tx, ctx) =>
      createReservation(tx, ctx, guest({ propertyId: prop, checkIn: d(60), checkOut: d(63) })),
    );
    await expect(
      as(O, ws, (tx, ctx) =>
        updateReservation(
          tx,
          ctx,
          id,
          guest({ propertyId: prop, checkIn: d(33), checkOut: d(36) }),
        ),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Diğer mülkte aynı tarihler serbest.
    await as(O, ws, (tx, ctx) =>
      createReservation(tx, ctx, guest({ propertyId: prop2, checkIn: d(33), checkOut: d(36) })),
    );
    // Sonradan gelen harici olay mevcut beklemede kaydı onaylamayı ENGELLEMEZ (yalnız uyarı).
    const pend = await as(O, ws, (tx, ctx) =>
      createReservation(
        tx,
        ctx,
        guest({ propertyId: prop, checkIn: d(70), checkOut: d(72), status: "pending" }),
      ),
    );
    feeds.set(
      URL_A,
      calendar({ uid: "a1@airbnb", from: 31, to: 35 }, { uid: "a3@airbnb", from: 71, to: 73 }),
    );
    await age(srcOf("Airbnb"));
    const r = await manualSync(O, ws, srcOf("Airbnb"));
    expect(r).toMatchObject({ outcome: "ok", conflicts: 1 });
    await as(O, ws, (tx, ctx) => confirmReservation(tx, ctx, pend));
    const [a] = (await as(O, ws, (tx, ctx) => listSources(tx, ctx, prop))).filter(
      (s) => s.name === "Airbnb",
    );
    expect(a!.conflictCount).toBe(1);
  });

  it("villa sayfası (public) harici dolulukları dolu gösterir ve web talebini reddeder", async () => {
    const slug = `ical-${tag}`;
    await as(O, ws, (tx, ctx) => updateWorkspaceWhatsapp(tx, ctx, "0532 000 11 22"));
    await as(O, ws, async (tx) => {
      const id = uuidv7();
      await tx.execute(sql`
        insert into property_photos (id, workspace_id, property_id, created_by, storage_prefix, width,
                                     height, quality, bytes_400, bytes_1200, bytes_2000, is_cover)
        values (${id}, ${ws}, ${prop}, app_current_user_id(), ${photoPrefix(ws, prop, id)},
                1800, 1200, 82, 1, 1, 1, true)`);
    });
    await as(O, ws, (tx, ctx) =>
      updatePublicSlug(tx, ctx, prop, { publicSlug: slug, confirmSlugChange: false }),
    );
    await as(O, ws, (tx, ctx) => publishProperty(tx, ctx, prop));
    const v = await getPublicVilla(app, null, slug);
    expect(v!.busy.some((b) => b.start <= d(31) && b.end >= d(35))).toBe(true);
    const res = await submitReservationRequest(app, {
      slug,
      checkIn: d(32),
      checkOut: d(34),
      guests: 2,
      name: "Can Demir",
      phone: "0532 111 22 33",
      consent: true,
      website: "",
      openedAt: Date.now() - 60_000,
    });
    expect(res).toMatchObject({ ok: false });
    // Uygulama denetimi atlanıp veritabanı fonksiyonu doğrudan çağrılsa da tetikleyici reddeder.
    const direct = await app
      .execute(
        sql`select * from app_public_reservation_request(${uuidv7()}::uuid, ${slug}, ${d(32)}::date,
              ${d(34)}::date, 2, 'Can Demir', '+905321112233', null, null, null, null)`,
      )
      .catch((e: unknown) => e);
    expect(pgErrorInfo(direct)).toMatchObject({
      code: "23P01",
      message: "reservation_external_overlap",
    });
  });
});

/** Katlanmış (75 bayt) iCal satırlarını birleştirir. */
const unfold = (text: string) =>
  text
    .replace(/\r\n[ \t]/g, "")
    .split("\r\n")
    .filter(Boolean);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * Dışa aktarma akışında YALNIZ bu satırlar olabilir (izin listesi). Misafir adı, telefon,
 * e-posta, tutar, not veya kişi sayısı taşıyabilecek hiçbir alan yoktur; her değerin biçimi sabit.
 */
const ALLOWED_EXPORT_LINES: RegExp[] = [
  /^BEGIN:(?:VCALENDAR|VEVENT)$/,
  /^END:(?:VCALENDAR|VEVENT)$/,
  /^VERSION:2\.0$/,
  /^PRODID:-\/\/Kiraligim\/\/Takvim 1\.0\/\/TR$/,
  /^CALSCALE:GREGORIAN$/,
  /^METHOD:PUBLISH$/,
  /^X-WR-CALNAME:Villa Defne – Kiralığım$/,
  new RegExp(`^UID:${UUID}@kiraligim\\.com$`),
  /^(?:DTSTAMP|CREATED|LAST-MODIFIED):\d{8}T\d{6}Z$/,
  /^(?:DTSTART|DTEND);VALUE=DATE:\d{8}$/,
  /^SUMMARY:Dolu \(Kiralığım\)$/,
  /^STATUS:CONFIRMED$/,
  /^TRANSP:OPAQUE$/,
];
const uidsOf = (text: string) =>
  unfold(text)
    .filter((l) => l.startsWith("UID:"))
    .map((l) => l.slice(4, 40))
    .sort();

/**
 * Misafir verisi sızıntısı denetimi: (1) her satır izin listesinde; (2) test verisindeki misafir
 * adları, e-posta, not ve telefonların BÜTÜN yazımları (en az 7 rakam: rastgele UID veya zaman
 * damgasında tesadüfen oluşamaz) akışta yok. Kısa rakam dizileri ("532") aranmaz: UID ve zaman
 * damgaları rakam içerir.
 */
function expectNoGuestData(text: string) {
  for (const line of unfold(text)) {
    expect(
      ALLOWED_EXPORT_LINES.some((re) => re.test(line)),
      `izin verilmeyen iCal satırı: ${line}`,
    ).toBe(true);
  }
  const folded = text.toLowerCase().replace(/\r\n[ \t]/g, "");
  for (const secret of ["mehmet", "kaya", "mehmet@ornek.com", "can demir", "bakım", "gizli"]) {
    expect(folded).not.toContain(secret);
  }
  for (const phone of ["+90 532 123 45 67", "0532 111 22 33", "0532 000 11 22"]) {
    const n = phone.replace(/\D/g, ""); // 905321234567 / 05321112233 / 05320001122
    for (const form of [n, n.replace(/^90/, ""), n.replace(/^0/, ""), n.slice(-7)]) {
      expect(folded, `telefon: ${form}`).not.toContain(form);
    }
    expect(folded).not.toContain(phone.toLowerCase());
  }
}

describe("dışa aktarma (export)", () => {
  let token = "";

  it("7–8) Kiraligim rezervasyonları ve blokları aktarılır; misafir bilgisi yoktur", async () => {
    await as(O, ws, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "block",
        propertyId: prop,
        checkIn: d(90),
        checkOut: d(92),
        note: "Bakım - gizli not",
      }),
    );
    const exp = await as(O, ws, (tx, ctx) => ensureExport(tx, ctx, prop));
    token = exp!.token;
    const feed = await buildExportFeed(app, token);
    expect(feed.ok).toBe(true);
    const text = feed.ok ? feed.ics : "";
    expect(text).toContain(`DTSTART;VALUE=DATE:${ics(d(60))}`); // rezervasyon (onaylı)
    expect(text).toContain(`DTSTART;VALUE=DATE:${ics(d(70))}`); // onaylanan talep
    expect(text).toContain(`DTSTART;VALUE=DATE:${ics(d(90))}`); // blok
    expect(text).toContain(`DTEND;VALUE=DATE:${ics(d(92))}`);
    expectNoGuestData(text);
    // Akıştaki olaylar yalnız bu mülkün aktif kayıtlarıdır (UID = kayıt kimliği).
    const ids = (
      await admin.query<{ id: string }>(
        "select id from reservations where property_id = $1 and status <> 'cancelled' order by id",
        [prop],
      )
    ).rows.map((r) => r.id);
    expect(uidsOf(text)).toEqual(ids);
  });

  it("CI regresyonu: zaman damgası '…T192532Z' gibi rakamlar içerebilir; misafir verisi değildir", async () => {
    // GitHub Actions 2efd079: test 19:25:32 UTC'de çalıştı ve DTSTAMP/CREATED/LAST-MODIFIED
    // değerleri "…T192532Z" oldu; eski test akışın TAMAMINDA "532" arıyordu (telefonun alan kodu)
    // ve yanlış alarm verdi. Akışta telefon yoktur; denetim alan bazında yapılır.
    const feed = await buildExportFeed(app, token, new Date("2026-11-11T19:25:32Z"));
    const text = feed.ok ? feed.ics : "";
    expect(text).toContain("DTSTAMP:20261111T192532Z");
    expect(text).toContain("532"); // yalnız zaman damgasında
    expectNoGuestData(text);
  });

  it("9) harici doluluklar dışa aktarmaya geri dönmez; iptal edilen kayıt çıkar", async () => {
    const feed = await buildExportFeed(app, token);
    const text = feed.ok ? feed.ics : "";
    expect(text).not.toContain("airbnb");
    expect(text).not.toContain("booking");
    expect(text).not.toContain(`DTSTART;VALUE=DATE:${ics(d(31))}`);
    expect(text).not.toContain(`DTSTART;VALUE=DATE:${ics(d(35))}`); // 3.1'de iptal edilen
    // Kendi akışımız içe aktarılırsa olaylar atlanır (döngü emniyeti).
    const back = await parseIcs(text, T);
    expect(back).toMatchObject({ ok: true, events: [] });
  });

  it("10) belirteçsiz, yanlış veya eski belirteçle erişilemez; başka işletme göremez", async () => {
    expect(await buildExportFeed(app, "")).toEqual({ ok: false });
    expect(await buildExportFeed(app, "x".repeat(43))).toEqual({ ok: false });
    expect(await buildExportFeed(app, `${token.slice(0, 42)}'`)).toEqual({ ok: false });
    const rotated = await as(M, ws, (tx, ctx) => rotateExport(tx, ctx, prop));
    expect(rotated.token).not.toBe(token);
    expect(await buildExportFeed(app, token)).toEqual({ ok: false });
    expect((await buildExportFeed(app, rotated.token)).ok).toBe(true);
    // Staff belirteci göremez; başka işletme mülkün belirtecini oluşturamaz.
    expect(await as(S, ws, (tx, ctx) => ensureExport(tx, ctx, prop))).toBeNull();
    await expect(as(X, wsX, (tx, ctx) => ensureExport(tx, ctx, prop))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // Okunma zamanı kaydedilir.
    const r = await admin.query(
      "select last_fetched_at from property_ical_exports where property_id = $1",
      [prop],
    );
    expect(r.rows[0].last_fetched_at).not.toBeNull();
  });

  it("pasif işletmenin akışı kapanır", async () => {
    const t = (await as(O, ws, (tx, ctx) => ensureExport(tx, ctx, prop)))!.token;
    await admin.query("update workspaces set status = 'suspended' where id = $1", [ws]);
    try {
      expect(await buildExportFeed(app, t)).toEqual({ ok: false });
    } finally {
      await admin.query("update workspaces set status = 'active' where id = $1", [ws]);
    }
  });
});

describe("yetki ve izolasyon", () => {
  it("staff kaynak ekleyemez/silemez, adresi göremez; başka işletme kaynağı göremez", async () => {
    await expect(
      as(S, ws, (tx, ctx) =>
        addSource(tx, ctx, prop, { name: "Vrbo", url: "https://vrbo.example/a.ics" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const staffView = await as(S, ws, (tx, ctx) => listSources(tx, ctx, prop));
    expect(staffView.length).toBeGreaterThan(0);
    expect(staffView.every((s) => s.url === null && !s.maskedUrl.includes("gizli"))).toBe(true);
    await expect(
      as(S, ws, (tx, ctx) => deleteSource(tx, ctx, staffView[0]!.id)),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await as(X, wsX, (tx, ctx) => listSources(tx, ctx, prop))).toEqual([]);
    await expect(
      as(X, wsX, (tx, ctx) => deleteSource(tx, ctx, staffView[0]!.id)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      as(X, wsX, (tx, ctx) =>
        addSource(tx, ctx, prop, { name: "Sızma", url: "https://x.example/a.ics" }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await as(X, wsX, (tx) => listExternalBlocks(tx, prop, d(0), d(90)))).toEqual([]);
    // Başka işletme kendi mülküne aynı adresi ekleyebilir; birbirlerini görmezler.
    await as(X, wsX, (tx, ctx) => addSource(tx, ctx, propX, { name: "Airbnb", url: URL_A }));
    expect((await as(X, wsX, (tx, ctx) => listSources(tx, ctx, propX))).map((s) => s.name)).toEqual(
      ["Airbnb"],
    );
    expect(
      (await as(O, ws, (tx, ctx) => listSources(tx, ctx, prop))).some(
        (s) => s.propertyId === propX,
      ),
    ).toBe(false);
  });

  it("app_user olayları ve senkron kayıtlarını doğrudan yazamaz; durum kolonlarını değiştiremez", async () => {
    const src = srcOf("Airbnb");
    const tryIt = (q: ReturnType<typeof sql>) =>
      as(O, ws, (tx) => tx.execute(q)).catch((e: unknown) => pgErrorInfo(e).code);
    expect(
      await tryIt(sql`insert into external_calendar_events (id, workspace_id, property_id, source_id, uid, start_date, end_date)
                      values (${uuidv7()}, ${ws}, ${prop}, ${src}, 'sahte', ${d(5)}::date, ${d(6)}::date)`),
    ).toBe("42501");
    expect(
      await tryIt(
        sql`update external_calendar_events set is_active = false where source_id = ${src}`,
      ),
    ).toBe("42501");
    expect(
      await tryIt(sql`update external_calendar_sources set status = 'ok' where id = ${src}`),
    ).toBe("42501");
    expect(await tryIt(sql`delete from external_calendar_sync_runs`)).toBe("42501");
  });

  it("doğrulama: geçersiz adres, aynı ad, aynı adres; denetim kaydında adres yok", async () => {
    await expect(
      as(O, ws, (tx, ctx) =>
        addSource(tx, ctx, prop2, { name: "X", url: "ftp://x.example/a.ics" }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { url: expect.any(Array) } });
    // Yerel/özel adresler kayıttan önce reddedilir; tabloya satır yazılmaz.
    const countP2 = async () =>
      (
        await admin.query(
          "select count(*)::int c from external_calendar_sources where property_id = $1",
          [prop2],
        )
      ).rows[0].c as number;
    const before = await countP2();
    for (const url of [
      "http://127.0.0.1/a.ics",
      "webcal://localhost/a.ics",
      "https://192.168.1.10/a.ics",
    ]) {
      await expect(
        as(O, ws, (tx, ctx) => addSource(tx, ctx, prop2, { name: "Yerel", url })),
      ).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { url: expect.any(Array) } });
    }
    expect(await countP2()).toBe(before);
    await as(O, ws, (tx, ctx) => addSource(tx, ctx, prop2, { name: "Airbnb", url: URL_A }));
    await expect(
      as(O, ws, (tx, ctx) => addSource(tx, ctx, prop2, { name: "airbnb", url: URL_B })),
    ).rejects.toMatchObject({ fieldErrors: { name: expect.any(Array) } });
    await expect(
      as(O, ws, (tx, ctx) => addSource(tx, ctx, prop2, { name: "Diğer", url: URL_A })),
    ).rejects.toMatchObject({ fieldErrors: { url: expect.any(Array) } });
    const audit = await admin.query(
      "select action, metadata::text m from audit_log where workspace_id = $1 and action like 'property.ical%'",
      [ws],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    for (const r of audit.rows) {
      expect(r.m).not.toContain("gizli");
      expect(r.m).not.toContain("airbnb");
    }
  });

  it("adres değişince durum sıfırlanır; mülk başına en fazla 10 kaynak", async () => {
    const src = srcOf("Airbnb");
    await as(O, ws, (tx, ctx) =>
      updateSource(tx, ctx, src, { name: "Airbnb", url: `${URL_A}&v=2`, isActive: "on" }),
    );
    const [s] = (await as(O, ws, (tx, ctx) => listSources(tx, ctx, prop))).filter(
      (x) => x.id === src,
    );
    expect(s).toMatchObject({ status: "pending", lastSyncedAt: null });
    // Düzenlemede de yerel adres reddedilir; kayıt değişmez.
    await expect(
      as(O, ws, (tx, ctx) =>
        updateSource(tx, ctx, src, {
          name: "Airbnb",
          url: "http://10.0.0.5/a.ics",
          isActive: "on",
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { url: expect.any(Array) } });
    expect(
      (await admin.query("select url from external_calendar_sources where id = $1", [src])).rows[0]
        .url,
    ).toBe(`${URL_A}&v=2`);
    const p3 = await villa(O, ws, "Villa Limit");
    for (let i = 0; i < 10; i++) {
      await as(O, ws, (tx, ctx) =>
        addSource(tx, ctx, p3, { name: `K${i}`, url: `https://k${i}.example/a.ics` }),
      );
    }
    await expect(
      as(O, ws, (tx, ctx) =>
        addSource(tx, ctx, p3, { name: "K10", url: "https://k10.example/a.ics" }),
      ),
    ).rejects.toMatchObject({ code: "LIMIT_REACHED" });
  });
});

describe("SECURITY DEFINER fonksiyon sınırları", () => {
  it("parametreler sabit; geçersiz çağrılar reddedilir; kilitsiz sonuç yazılamaz", async () => {
    const r = await admin.query(`
      select proname, pg_get_function_identity_arguments(oid) as args from pg_proc
       where pronamespace = 'public'::regnamespace and proname like 'app\\_ical\\_%' and prosecdef
       order by 1`);
    expect(r.rows).toEqual([
      {
        proname: "app_ical_apply_sync",
        args: "p_source uuid, p_lock_token uuid, p_trigger text, p_started_at timestamp with time zone, p_events jsonb, p_error_code text",
      },
      { proname: "app_ical_claim_sources", args: "p_source uuid, p_trigger text, p_limit integer" },
      { proname: "app_ical_export", args: "p_token text" },
    ]);
    const code = (q: ReturnType<typeof sql>) =>
      app.execute(q).then(
        () => "ok",
        (e: unknown) => pgErrorInfo(e).message,
      );
    expect(await code(sql`select * from app_ical_claim_sources(null, 'manual', 1)`)).toBe(
      "ical_claim_invalid",
    );
    expect(await code(sql`select * from app_ical_claim_sources(null, 'cron', 500)`)).toBe(
      "ical_claim_invalid",
    );
    expect(
      await code(
        sql`select * from app_ical_apply_sync(${srcOf("Airbnb")}::uuid, ${uuidv7()}::uuid, 'cron', now(), '[]'::jsonb, null)`,
      ),
    ).toBe("ical_lock_lost");
  });
});
