import { createHash, randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool, type PoolClient } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import { pgErrorInfo } from "@/db/pg-error";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import type { FetchIcsResult } from "@/server/ical/fetch";
import { createLogger } from "@/lib/logger";
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import { addSource, deleteSource, setSourceActive, updateSource } from "@/server/ical/service";
import { claimSource, syncClaimed } from "@/server/ical/sync";
import { photoPrefix } from "@/server/properties/photos";
import { publishProperty, updatePublicSlug } from "@/server/properties/public-profile";
import { createProperty, setPropertyStatus } from "@/server/properties/service";
import { submitReservationRequest } from "@/server/public/reservation-request";
import {
  cancelReservation,
  confirmReservation,
  createReservation,
  rescheduleReservation,
  updateReservation,
} from "@/server/reservations/service";
import { createAutoChanger } from "@/server/whatsapp/auto-change";
import { createAutoCloser } from "@/server/whatsapp/auto-close";
import { createAutoOpener } from "@/server/whatsapp/auto-open";
import { runCalendarWorker, type WorkerDeps } from "@/server/whatsapp/calendar/worker";
import { updateWorkspaceWhatsapp } from "@/server/workspaces/contact";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

/**
 * API 2. aşama, 1. adım — takvim değişikliği yakalama (drizzle/0053, 0054).
 * Gerçek PostgreSQL 17: panel ve WhatsApp app_user + FORCE RLS ile, villa sayfası talebi
 * oturumsuz app_user + SECURITY DEFINER fonksiyonuyla, iCal senkronu üretimdeki claim/sync
 * koduyla (sahte indirici) çalışır; tetikleyiciler hangi yoldan yazılırsa yazılsın aynıdır.
 *
 * Doğrulananlar: takvimi etkileyen her yazma AYNI transaction'da doğru eski/yeni aralık satırı
 * bırakır; takvimi etkilemeyen yazmalar (beklemede → onaylı, misafir/tutar/not, iCal'in aynı
 * değerlerle yeniden yazımı, ad değişiklikleri, pasif kaynağın silinmesi) satır bırakmaz; geri
 * alınan yazma (transaction, savepoint, kısıt hatası) satır bırakmaz; eşzamanlı yazmalar birbirini
 * beklemez ve hepsi kaydedilir; tabloya hiçbir uygulama rolü doğrudan erişemez.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 10 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const log = createLogger({ service: "api-capture-test" }, () => {});
const T = istanbulToday();
const d = (n: number) => addDays(T, n);
const W = { start: d(-366), end: d(731) }; // tam pencere

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
const phoneHash = (pn: string) => createHash("sha256").update(`wa-phone:${pn}`).digest("hex");

let O: U, X: U;
let ws: string, wsX: string;
let mavi: string, asya: string, talep: string, ical: string, villaX: string;
const planCode = `api_cap_${tag}`;

type Row = { property: string; start: string; end: string; reason: string };
/** İşaretten sonra yazılan satırlar (id sırası). */
const mark = async () =>
  Number(
    (await admin.query("select coalesce(max(id), 0)::bigint m from api_calendar_dirty")).rows[0].m,
  );
const since = async (m: number, props?: string[]): Promise<Row[]> =>
  (
    await admin.query(
      `select property_id property, start_date::text start, end_date::text "end", reason
         from api_calendar_dirty where id > $1 and ($2::uuid[] is null or property_id = any($2))
        order by id`,
      [m, props ?? null],
    )
  ).rows;
const r = (property: string, start: string, end: string, reason = "reservation"): Row => ({
  property,
  start,
  end,
  reason,
});

async function villa(u: U, w: string, name: string) {
  return as(u, w, (tx, ctx) =>
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
const guest = (over: Record<string, unknown>) => ({
  kind: "reservation",
  guestName: "Mehmet Kaya",
  guestPhone: "+90 532 123 45 67",
  adults: "2",
  children: "0",
  source: "direct",
  ...over,
});
const block = (propertyId: string, a: number, b: number) =>
  as(O, ws, (tx, ctx) =>
    createReservation(tx, ctx, { kind: "block", propertyId, checkIn: d(a), checkOut: d(b) }),
  );

// --- WhatsApp (üretimdeki worker + otomatik kapat/aç/değiştir) ---------------------------------
const PN_OWNER = `9053266${String(parseInt(tag, 16) % 100_000).padStart(5, "0")}`;
const AYLAR = [
  "Ocak",
  "Şubat",
  "Mart",
  "Nisan",
  "Mayıs",
  "Haziran",
  "Temmuz",
  "Ağustos",
  "Eylül",
  "Ekim",
  "Kasım",
  "Aralık",
];
const tr = (iso: string) => `${Number(iso.slice(8, 10))} ${AYLAR[Number(iso.slice(5, 7)) - 1]}`;
const tr2 = (a: string, b: string) => `${tr(a)}-${tr(b)}`;
function md(months: number, day: number): string {
  const y = Number(T.slice(0, 4));
  const m0 = Number(T.slice(5, 7)) - 1 + months;
  const yy = y + Math.floor(m0 / 12);
  return `${yy}-${String((m0 % 12) + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
const waDeps = (): WorkerDeps => ({
  log,
  autoClose: createAutoCloser(app),
  autoOpen: createAutoOpener(app),
  autoChange: createAutoChanger(app),
});
let conn: string;
let groupJid: string;
let msgN = 0;
async function wa(body: string) {
  await appPool.query(
    "select public.app_wa_ingest_message($1, $2, $3, '1@lid', $4, null, $5, now(), 'live')",
    [conn, groupJid, `CAP${tag}${++msgN}`, PN_OWNER, body],
  );
  await runCalendarWorker(app, waDeps());
}

// --- iCal (sahte indirici) ---------------------------------------------------------------------
const feeds = new Map<string, string>();
const fetcher = async (url: string): Promise<FetchIcsResult> => {
  const v = feeds.get(url);
  return v === undefined ? { ok: false, code: "http_status" } : { ok: true, text: v };
};
const ics = (iso: string) => iso.replace(/-/g, "");
const calendar = (...events: { uid: string; from: number; to: number }[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//TR",
    ...events.flatMap((e) => [
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      "SUMMARY:Reserved",
      `DTSTART;VALUE=DATE:${ics(d(e.from))}`,
      `DTEND;VALUE=DATE:${ics(d(e.to))}`,
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join("\r\n");
async function icalSync(sourceId: string) {
  await admin.query(
    "update external_calendar_sources set last_synced_at = now() - interval '5 hours' where id = $1",
    [sourceId],
  );
  const c = await as(O, ws, (tx) => claimSource(tx, sourceId));
  expect(c.outcome).toBe("claimed");
  return syncClaimed(app, c.claim!, "manual", { fetcher, today: () => T });
}

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("capo");
  X = await mkUser("capx");
  const M = await mkUser("capm");
  ws = (await createWorkspace(app, { userId: O.id, name: "Yakalama", slug: `cap-${tag}` })).id;
  wsX = (await createWorkspace(app, { userId: X.id, name: "Başka", slug: `capx-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'Yakalama', 20, 14, true, false)",
    [planId, planCode],
  );
  await admin.query(
    "update workspace_subscriptions set plan_id = $1 where workspace_id = any($2)",
    [planId, [ws, wsX]],
  );
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  mavi = await villa(O, ws, "Villa Mavi");
  asya = await villa(O, ws, "Villa Asya");
  talep = await villa(O, ws, "Villa Talep");
  ical = await villa(O, ws, "Villa iCal");
  villaX = await villa(X, wsX, "Başka Villa");

  // Villa sayfası talebi için yayındaki villa.
  await as(O, ws, (tx, ctx) => updateWorkspaceWhatsapp(tx, ctx, "0532 000 44 55"));
  await as(O, ws, async (tx) => {
    const id = uuidv7();
    await tx.execute(sql`
      insert into property_photos (id, workspace_id, property_id, created_by, storage_prefix, width,
                                   height, quality, bytes_400, bytes_1200, bytes_2000, is_cover)
      values (${id}, ${ws}, ${talep}, app_current_user_id(), ${photoPrefix(ws, talep, id)},
              1800, 1200, 82, 1, 1, 1, true)`);
  });
  await as(O, ws, (tx, ctx) =>
    updatePublicSlug(tx, ctx, talep, { publicSlug: `talep-${tag}`, confirmSlugChange: false }),
  );
  await as(O, ws, (tx, ctx) => publishProperty(tx, ctx, talep));

  // WhatsApp: Villa Mavi'ye bağlı grup, doğrulanmış sahip numarası, worker aktivasyonu.
  conn = (
    await appPool.query<{ id: string }>("select public.app_wa_heartbeat($1, 'open', null) as id", [
      `cap-${tag}`,
    ])
  ).rows[0]!.id;
  groupJid = `120369${String(parseInt(tag, 16) % 10_000_000).padStart(7, "0")}00001@g.us`;
  await appPool.query("select public.app_wa_sync_group($1, $2, 'Ekip', 4, false, false, true)", [
    conn,
    groupJid,
  ]);
  await admin.query(
    "update wa_groups set status = 'linked', workspace_id = $2, property_id = $3, linked_at = now() where jid = $1",
    [groupJid, ws, mavi],
  );
  await admin.query(
    "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 01')",
    [O.id, phoneHash(PN_OWNER)],
  );
  await runCalendarWorker(app, waDeps());
});

afterAll(async () => {
  await admin.query("delete from wa_inbound_messages where workspace_id = $1", [ws]);
  await admin.query(
    "update workspace_subscriptions set plan_id = (select id from plans where is_default) where workspace_id = any($1)",
    [[ws, wsX]],
  );
  await admin.query("delete from plans where code = $1", [planCode]);
  await admin.end();
  await appPool.end();
});

describe("panel: rezervasyon ve blok", () => {
  it("oluşturma: [giriş, çıkış) satırı; misafir/tutar/not değişikliği satır bırakmaz", async () => {
    const m = await mark();
    const id = await as(O, ws, (tx, ctx) =>
      createReservation(tx, ctx, guest({ propertyId: mavi, checkIn: d(10), checkOut: d(14) })),
    );
    expect(await since(m)).toEqual([r(mavi, d(10), d(14))]);
    const m2 = await mark();
    await as(O, ws, (tx, ctx) =>
      updateReservation(tx, ctx, id, {
        ...guest({ propertyId: mavi, checkIn: d(10), checkOut: d(14) }),
        guestName: "Başka Ad",
        note: "Yeni not",
        totalAmount: "1.000",
        currency: "EUR",
      }),
    );
    expect(await since(m2)).toEqual([]);
  });

  it("beklemede → onaylı satır bırakmaz; iptal eski aralığı bırakır; iptalli kayıt tekrar etkilemez", async () => {
    const id = await as(O, ws, (tx, ctx) =>
      createReservation(
        tx,
        ctx,
        guest({ propertyId: mavi, checkIn: d(20), checkOut: d(23), status: "pending" }),
      ),
    );
    const m = await mark();
    await as(O, ws, (tx, ctx) => confirmReservation(tx, ctx, id));
    expect(await since(m)).toEqual([]);
    await as(O, ws, (tx, ctx) => cancelReservation(tx, ctx, id));
    expect(await since(m)).toEqual([r(mavi, d(20), d(23))]);
    // İptal edilmiş kayıt değiştirilemez (mevcut koruma, reservation_cancelled_immutable).
    await expect(
      admin.query("update reservations set note = 'x' where id = $1", [id]),
    ).rejects.toThrow("reservation_cancelled_immutable");
    expect(await since(m)).toEqual([r(mavi, d(20), d(23))]);
  });

  it("tarih değiştirme: eski ve yeni aralık ayrı satır (önce eski)", async () => {
    const id = await block(mavi, 30, 33);
    const m = await mark();
    await as(O, ws, (tx, ctx) =>
      rescheduleReservation(tx, ctx, id, { checkIn: d(31), checkOut: d(35) }),
    );
    expect(await since(m)).toEqual([r(mavi, d(30), d(33)), r(mavi, d(31), d(35))]);
    // Yalnız çıkış değişse de iki satır (eski tam aralık + yeni tam aralık).
    const m2 = await mark();
    await as(O, ws, (tx, ctx) =>
      rescheduleReservation(tx, ctx, id, { checkIn: d(31), checkOut: d(36) }),
    );
    expect(await since(m2)).toEqual([r(mavi, d(31), d(35)), r(mavi, d(31), d(36))]);
  });

  it("villa değişmez (mevcut koruma); kaydın silinmesi eski aralığı bildirir", async () => {
    const id = await block(mavi, 40, 42);
    const m = await mark();
    await expect(
      admin.query("update reservations set property_id = $2 where id = $1", [id, asya]),
    ).rejects.toThrow("reservation_immutable_field");
    expect(await since(m)).toEqual([]);
    await admin.query("delete from reservations where id = $1", [id]);
    expect(await since(m)).toEqual([r(mavi, d(40), d(42))]);
  });
});

describe("WhatsApp: kapat / aç / tarih değiştir", () => {
  it("üretimdeki worker yolu doğru aralıkları bırakır; işlem olmayan mesaj bırakmaz", async () => {
    const [a, b, c, e] = [md(2, 10), md(2, 14), md(2, 16), md(2, 20)];
    const m = await mark();
    await wa(`${tr2(a, b)} kapatalım`);
    expect(await since(m, [mavi])).toEqual([r(mavi, a, b)]);

    const m2 = await mark();
    await wa(`${tr2(a, b)} rezervasyonu ${tr2(c, e)} olarak değiştirildi`);
    expect(await since(m2, [mavi])).toEqual([r(mavi, a, b), r(mavi, c, e)]);

    const m3 = await mark();
    await wa(`${tr2(c, e)} tekrar müsait`);
    expect(await since(m3, [mavi])).toEqual([r(mavi, c, e)]);

    const m4 = await mark();
    await wa("Merhaba, havuz temizlendi mi?");
    await wa(`${tr2(a, b)} kapatmayalım`);
    expect(await since(m4)).toEqual([]);
  });
});

describe("villa sayfası rezervasyon talebi", () => {
  it("beklemedeki talep aralığı bildirir; reddedilen talep bildirmez", async () => {
    const form = (a: number, b: number) => ({
      slug: `talep-${tag}`,
      checkIn: d(a),
      checkOut: d(b),
      guests: 2,
      name: "Ayşe Yılmaz",
      phone: "0532 111 22 33",
      consent: true,
      website: "",
      openedAt: Date.now() - 60_000,
    });
    const m = await mark();
    const ok = await submitReservationRequest(app, form(50, 54));
    expect(ok.ok).toBe(true);
    expect(await since(m)).toEqual([r(talep, d(50), d(54))]);
    const m2 = await mark();
    const busy = await submitReservationRequest(app, form(51, 53));
    expect(busy).toMatchObject({ ok: false, code: "dates_unavailable" });
    expect(await since(m2)).toEqual([]);
  });
});

describe("Airbnb/Booking iCal", () => {
  let src: string;
  const url = `https://www.airbnb.com/calendar/ical/cap-${tag}.ics`;

  it("ilk senkron her etkin olayı bildirir", async () => {
    feeds.set(url, calendar({ uid: "a", from: 60, to: 63 }, { uid: "b", from: 70, to: 72 }));
    src = await as(O, ws, (tx, ctx) =>
      addSource(tx, ctx, ical, { name: "Airbnb", url, isActive: "on" }),
    );
    const m = await mark();
    expect((await icalSync(src)).outcome).toBe("ok");
    expect(await since(m)).toEqual([
      r(ical, d(60), d(63), "external_event"),
      r(ical, d(70), d(72), "external_event"),
    ]);
  });

  it("değişmeyen akışın yeniden senkronu satır bırakmaz", async () => {
    const m = await mark();
    expect((await icalSync(src)).outcome).toBe("ok");
    expect((await icalSync(src)).outcome).toBe("ok");
    expect(await since(m)).toEqual([]);
  });

  it("tarih değişikliği eski + yeni, kaybolan olay eski, yeni olay yeni aralığı bildirir", async () => {
    feeds.set(url, calendar({ uid: "a", from: 61, to: 64 }, { uid: "c", from: 80, to: 81 }));
    const m = await mark();
    expect((await icalSync(src)).outcome).toBe("ok");
    expect(await since(m)).toEqual(
      expect.arrayContaining([
        r(ical, d(60), d(63), "external_event"),
        r(ical, d(61), d(64), "external_event"),
        r(ical, d(70), d(72), "external_event"),
        r(ical, d(80), d(81), "external_event"),
      ]),
    );
    expect(await since(m)).toHaveLength(4);
  });

  it("kaynak adı/adresi değişimi bildirmez; pasif/etkin geçişi tam pencere", async () => {
    const m = await mark();
    await as(O, ws, (tx, ctx) =>
      updateSource(tx, ctx, src, { name: "Airbnb 2", url, isActive: "on" }),
    );
    expect(await since(m)).toEqual([]);
    await as(O, ws, (tx, ctx) => setSourceActive(tx, ctx, src, false));
    expect(await since(m)).toEqual([r(ical, W.start, W.end, "external_source")]);
    const m2 = await mark();
    await as(O, ws, (tx, ctx) => setSourceActive(tx, ctx, src, true));
    expect(await since(m2)).toEqual([r(ical, W.start, W.end, "external_source")]);
  });

  it("etkin kaynağın silinmesi tek tam pencere satırı; pasif kaynağın silinmesi hiç", async () => {
    const m = await mark();
    await as(O, ws, (tx, ctx) => deleteSource(tx, ctx, src));
    expect(await since(m)).toEqual([r(ical, W.start, W.end, "external_source")]);

    const url2 = `https://www.booking.com/ical/cap-${tag}.ics`;
    feeds.set(url2, calendar({ uid: "z", from: 90, to: 92 }));
    const src2 = await as(O, ws, (tx, ctx) =>
      addSource(tx, ctx, ical, { name: "Booking", url: url2, isActive: "on" }),
    );
    expect((await icalSync(src2)).outcome).toBe("ok");
    await as(O, ws, (tx, ctx) => setSourceActive(tx, ctx, src2, false));
    const m2 = await mark();
    await as(O, ws, (tx, ctx) => deleteSource(tx, ctx, src2));
    expect(await since(m2)).toEqual([]);
  });
});

describe("villa ve işletme durumu", () => {
  it("villa pasif/etkin: tam pencere; ad değişikliği ve aynı durum bildirmez", async () => {
    const m = await mark();
    await as(O, ws, (tx, ctx) => setPropertyStatus(tx, ctx, asya, "passive"));
    expect(await since(m)).toEqual([r(asya, W.start, W.end, "property_status")]);
    const m2 = await mark();
    await as(O, ws, (tx, ctx) => setPropertyStatus(tx, ctx, asya, "passive"));
    await admin.query("update properties set name = 'Villa Asya 2' where id = $1", [asya]);
    expect(await since(m2)).toEqual([]);
    await as(O, ws, (tx, ctx) => setPropertyStatus(tx, ctx, asya, "active"));
    expect(await since(m2)).toEqual([r(asya, W.start, W.end, "property_status")]);
  });

  it("işletme askı/etkin: işletmenin bütün villaları; başka işletme ve ad değişikliği bildirmez", async () => {
    const all = [mavi, asya, talep, ical].sort();
    const m = await mark();
    await admin.query("update workspaces set status = 'suspended' where id = $1", [ws]);
    const rows = await since(m);
    expect(rows.map((x) => x.property).sort()).toEqual(all);
    for (const x of rows) expect(x).toMatchObject({ ...W, reason: "workspace_status" });
    const m2 = await mark();
    await admin.query("update workspaces set status = 'active' where id = $1", [ws]);
    expect((await since(m2)).map((x) => x.property).sort()).toEqual(all);
    const m3 = await mark();
    await admin.query("update workspaces set name = 'Yeni Ad' where id = $1", [ws]);
    await admin.query("update workspaces set status = 'active' where id = $1", [wsX]);
    expect(await since(m3)).toEqual([]);
  });
});

describe("geri alma (rollback)", () => {
  it("transaction geri alınırsa satır da geri alınır", async () => {
    const m = await mark();
    await expect(
      as(O, ws, async (tx, ctx) => {
        await createReservation(tx, ctx, {
          kind: "block",
          propertyId: mavi,
          checkIn: d(100),
          checkOut: d(102),
        });
        throw new Error("vazgeç");
      }),
    ).rejects.toThrow("vazgeç");
    expect(await since(m)).toEqual([]);
    expect(
      (
        await admin.query(
          "select count(*)::int n from reservations where property_id = $1 and check_in = $2",
          [mavi, d(100)],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("savepoint geri alınırsa yalnız kaydedilen kısım kalır", async () => {
    const m = await mark();
    await as(O, ws, async (tx, ctx) => {
      await tx
        .transaction(async (sp) => {
          await createReservation(sp, ctx, {
            kind: "block",
            propertyId: mavi,
            checkIn: d(110),
            checkOut: d(112),
          });
          throw new Error("iç");
        })
        .catch(() => undefined);
      await createReservation(tx, ctx, {
        kind: "block",
        propertyId: mavi,
        checkIn: d(120),
        checkOut: d(121),
      });
    });
    expect(await since(m)).toEqual([r(mavi, d(120), d(121))]);
  });

  it("çakışma (kısıt) hatasında satır yok", async () => {
    const m = await mark();
    await expect(block(mavi, 120, 122)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await since(m)).toEqual([]);
  });
});

describe("eşzamanlı yazmalar", () => {
  const begin = async (wsId: string, user: U) => {
    const c = await appPool.connect();
    await c.query("begin");
    await c.query(
      "select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
      [user.id, wsId],
    );
    return c;
  };
  const ins = (c: PoolClient, wsId: string, prop: string, a: number, b: number) =>
    c.query(
      `insert into reservations (id, workspace_id, property_id, kind, status, check_in, check_out, created_by)
       values ($1, $2, $3, 'block', 'confirmed', $4, $5, app_current_user_id())`,
      [uuidv7(), wsId, prop, d(a), d(b)],
    );

  it("farklı villalara açık transaction'lar birbirini beklemez; yalnız kaydedilenler kalır", async () => {
    const m = await mark();
    const c1 = await begin(ws, O);
    const c2 = await begin(wsX, X);
    const c3 = await begin(ws, O);
    try {
      await ins(c1, ws, mavi, 200, 202);
      // c1 açıkken diğerleri kilit beklemeden ilerlemeli.
      await c2.query("set local lock_timeout = '2s'");
      await c3.query("set local lock_timeout = '2s'");
      await ins(c2, wsX, villaX, 200, 202);
      await ins(c3, ws, asya, 205, 206);
      // Kaydedilmemiş satırlar görünmez.
      expect(await since(m)).toEqual([]);
      await c2.query("commit");
      await c3.query("rollback");
      await c1.query("commit");
    } finally {
      c1.release();
      c2.release();
      c3.release();
    }
    const rows = await since(m);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([r(villaX, d(200), d(202)), r(mavi, d(200), d(202))]),
    );
  });

  it("paralel 20 yazma: 20 satır, benzersiz ve sıralı kimlik", async () => {
    const m = await mark();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        as(O, ws, (tx, ctx) =>
          createReservation(tx, ctx, {
            kind: "block",
            propertyId: i % 2 ? mavi : asya,
            checkIn: d(300 + i * 2),
            checkOut: d(301 + i * 2),
          }),
        ),
      ),
    );
    const ids = (
      await admin.query("select id from api_calendar_dirty where id > $1 order by id", [m])
    ).rows.map((x) => Number(x.id));
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });
});

describe("güvenlik", () => {
  it("tablo hiçbir uygulama rolüne açık değil; RLS + FORCE", async () => {
    const cls = (
      await admin.query(
        "select relrowsecurity r, relforcerowsecurity f from pg_class where relname = 'api_calendar_dirty'",
      )
    ).rows[0];
    expect(cls).toEqual({ r: true, f: true });
    for (const role of ["app_user", "app_admin", "app_worker"]) {
      for (const priv of ["select", "insert", "update", "delete"]) {
        const ok = (
          await admin.query("select has_table_privilege($1, 'api_calendar_dirty', $2) ok", [
            role,
            priv,
          ])
        ).rows[0].ok;
        expect([role, priv, ok]).toEqual([role, priv, false]);
      }
    }
    await expect(appPool.query("select * from api_calendar_dirty limit 1")).rejects.toMatchObject({
      code: "42501",
    });
    // Bayrağı kendisi açsa da app_user ekleyemez (yetki yok; politika yalnız app_migrator).
    const c = await appPool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.api_capture', 'on', true)");
      const err = await c
        .query(
          "insert into api_calendar_dirty (property_id, start_date, end_date, reason) values ($1, current_date, current_date + 1, 'reservation')",
          [mavi],
        )
        .catch((e: unknown) => pgErrorInfo(e).code);
      expect(err).toBe("42501");
      await c.query("rollback");
    } finally {
      c.release();
    }
  });

  it("satırlarda yalnız villa, aralık ve neden var (kişisel veri yok)", async () => {
    const cols = (
      await admin.query(
        "select column_name from information_schema.columns where table_name = 'api_calendar_dirty' order by ordinal_position",
      )
    ).rows.map((x) => x.column_name);
    expect(cols).toEqual([
      "id",
      "property_id",
      "start_date",
      "end_date",
      "reason",
      "attempts",
      "next_attempt_at",
      "last_error",
      "created_at",
    ]);
  });

  it("tetikleyiciler beklenen tablolarda; fonksiyonlar sabit search_path, kimsede EXECUTE yok", async () => {
    const trg = (
      await admin.query(
        `select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where not t.tgisinternal and t.tgname like '%api_capture%' order by 1, 2`,
      )
    ).rows.map((x) => `${x.relname}.${x.tgname}`);
    expect(trg).toEqual([
      "external_calendar_events.external_calendar_events_api_capture_del",
      "external_calendar_events.external_calendar_events_api_capture_ins",
      "external_calendar_events.external_calendar_events_api_capture_upd",
      "external_calendar_sources.external_calendar_sources_api_capture_del",
      "external_calendar_sources.external_calendar_sources_api_capture_upd",
      "properties.properties_api_capture_status",
      "reservations.reservations_api_capture_del",
      "reservations.reservations_api_capture_ins",
      "reservations.reservations_api_capture_upd",
      "workspaces.workspaces_api_capture_status",
    ]);
    const fns = (
      await admin.query(
        `select proname, prosecdef, proconfig, pg_get_userbyid(proowner) owner,
                coalesce(array_length(proacl, 1), 0) acl_n,
                has_function_privilege('app_user', oid, 'execute') u,
                has_function_privilege('app_admin', oid, 'execute') a
           from pg_proc where proname like 'app\\_api\\_capture\\_%' order by 1`,
      )
    ).rows;
    expect(fns.map((x) => [x.proname, x.prosecdef])).toEqual([
      ["app_api_capture_external_event", true],
      ["app_api_capture_external_source", true],
      ["app_api_capture_insert", false],
      ["app_api_capture_property_status", true],
      ["app_api_capture_reservation", true],
      ["app_api_capture_workspace_status", true],
    ]);
    for (const f of fns) {
      expect(f.owner).toBe("app_migrator");
      expect(f.proconfig).toEqual(["search_path=pg_catalog, pg_temp"]);
      expect([f.proname, f.u, f.a]).toEqual([f.proname, false, false]);
    }
  });
});
