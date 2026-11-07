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
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import { createProperty, setPropertyStatus } from "@/server/properties/service";
import {
  createRate,
  deleteRate,
  findRateConflicts,
  getRate,
  listRates,
  propertyRateCurrency,
  quoteForProperty,
  updateRate,
} from "@/server/rates/service";
import { createReservation, getReservation } from "@/server/reservations/service";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

/**
 * Aşama 3.1: mülk fiyat dönemleri (0017, 0018) — gerçek PostgreSQL. Uygulama işlemleri yalnız
 * app_user ile; yönetici bağlantısı kurulum ve doğrulama içindir. Tarihler bugüne göre seçilir.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 8 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });

const tag = randomBytes(3).toString("hex");
const T = istanbulToday();
const d = (n: number) => addDays(T, n);

const pgMessage = (p: Promise<unknown>) =>
  p.then(
    () => "başarılı (hata bekleniyordu)",
    (err: unknown) => pgErrorInfo(err).message ?? String(err),
  );
const pgCode = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (err: unknown) => pgErrorInfo(err).code ?? String(err),
  );

type U = { id: string };
const mkUser = async (label: string): Promise<U> => {
  const u = { id: uuidv7() };
  await admin.query("insert into users (id, name, email) values ($1, $2, $3)", [
    u.id,
    `${label} K`,
    `${label}.${tag}@ornek.com`,
  ]);
  return u;
};
const mkWorkspace = async (owner: U, label: string) =>
  (await createWorkspace(app, { userId: owner.id, name: `${label} İş`, slug: `${label}-${tag}` }))
    .id;
const as = <T>(u: U, ws: string, fn: (tx: Tx, ctx: TenantContext) => Promise<T>) =>
  withTenant(app, { userId: u.id, workspaceId: ws }, fn);
const mkProperty = (u: U, ws: string) =>
  as(u, ws, (tx, ctx) =>
    createProperty(tx, ctx, {
      name: "Deniz Villa",
      propertyType: "villa",
      maxGuests: "6",
      bedrooms: "3",
      bathrooms: "2",
      province: "Antalya",
      district: "Kaş",
    }),
  );
/**
 * Aynı işletmede ikinci mülk (paket limiti 1). Paket kataloğunu değiştirmemek için (billing
 * testleri tek paket bekler) yalnız kurulumda, yönetici bağlantısında tetikleyiciler atlanır.
 */
const mkExtraProperty = async (ws: string, createdBy: U, name: string) => {
  const id = uuidv7();
  await admin.query("begin");
  try {
    await admin.query("set local session_replication_role = replica");
    await admin.query(
      `insert into properties (id, workspace_id, name, property_type, max_guests, bedrooms, bathrooms,
                               province, district, created_by)
       values ($1, $2, $3, 'villa', 6, 3, 2, 'Antalya', 'Kaş', $4)`,
      [id, ws, name, createdBy.id],
    );
    await admin.query("commit");
  } catch (err) {
    await admin.query("rollback");
    throw err;
  }
  return id;
};

/**
 * Form girdisi. Testte tarihler veritabanı biçiminde [başlangıç, bitiş) düşünülür; arayüz bitişi
 * DAHİL (son gece) aldığı için forma bitiş − 1 gönderilir.
 */
const rate = (startDate: string, endDate: string, over: Record<string, unknown> = {}) => ({
  startDate,
  lastNight: addDays(endDate, -1),
  nightlyAmount: "5.000",
  currency: "EUR",
  ...over,
});

/** Uygulama denetimini atlayan ham ekleme (yalnız veritabanı kuralları). */
const rawInsert = (
  tx: Tx,
  ws: string,
  property: string,
  start: string,
  end: string,
  extra: { nightly?: number | null; weekly?: number | null; currency?: string; min?: number } = {},
) =>
  tx.execute(sql`
    insert into property_rates (id, workspace_id, property_id, start_date, end_date,
                                nightly_amount_minor, weekly_amount_minor, currency, min_nights, created_by)
    values (${uuidv7()}, ${ws}, ${property}, ${start}, ${end},
            ${extra.nightly === undefined ? 100000 : extra.nightly}, ${extra.weekly ?? null},
            ${extra.currency ?? "EUR"}, ${extra.min ?? null}, app_current_user_id())`);

const rowOf = async (id: string) =>
  (
    await admin.query(
      `select to_char(start_date, 'YYYY-MM-DD') s, to_char(end_date, 'YYYY-MM-DD') e,
              nightly_amount_minor::text nightly, weekly_amount_minor::text weekly, currency,
              min_nights, cleaning_fee_minor::text cleaning, cleaning_fee_free_nights free_nights,
              created_by, workspace_id, property_id, created_at, updated_at
         from property_rates where id = $1`,
      [id],
    )
  ).rows[0];

const auditOf = async (ws: string, action: string) =>
  (
    await admin.query(
      "select actor_user_id, target_type, target_id, metadata from audit_log where workspace_id = $1 and action = $2 order by occurred_at, id",
      [ws, action],
    )
  ).rows;

let O: U, M: U, S: U, B: U;
let wsA: string, wsB: string, propA: string, propA2: string, propB: string;

beforeAll(async () => {
  await admin.connect();
  [O, M, S, B] = (await Promise.all(["foya", "fmert", "fselin", "fbaris"].map(mkUser))) as [
    U,
    U,
    U,
    U,
  ];
  wsA = await mkWorkspace(O, "fa");
  wsB = await mkWorkspace(B, "fb");
  await as(O, wsA, async (tx, ctx) => {
    await addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" });
    await addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" });
  });
  propA = await mkProperty(O, wsA);
  propA2 = await mkExtraProperty(wsA, O, "Bahçe Ev");
  propB = await mkProperty(B, wsB);
});

afterAll(async () => {
  await admin.end();
  await appPool.end();
});

describe("oluşturma", () => {
  it("gecelik fiyat: kuruş olarak saklanır, oluşturan bağlamdan, denetim kaydında değer yok", async () => {
    const id = await as(O, wsA, (tx, ctx) =>
      createRate(tx, ctx, propA, rate(d(30), d(60), { nightlyAmount: "5.000,50", minNights: "3" })),
    );
    expect(await rowOf(id)).toMatchObject({
      s: d(30),
      e: d(60),
      nightly: "500050",
      weekly: null,
      currency: "EUR",
      min_nights: 3,
      created_by: O.id,
      workspace_id: wsA,
      property_id: propA,
    });
    const audit = (await auditOf(wsA, "property.rate_created")).find((a) => a.target_id === id);
    expect(audit).toMatchObject({
      actor_user_id: O.id,
      target_type: "property_rate",
      metadata: { property: propA },
    });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/500050|5\.000/);
  });

  it("yalnız haftalık ve ikisi birlikte", async () => {
    const w = await as(O, wsA, (tx, ctx) =>
      createRate(tx, ctx, propA, rate(d(60), d(75), { nightlyAmount: "", weeklyAmount: "35.000" })),
    );
    expect(await rowOf(w)).toMatchObject({ nightly: null, weekly: "3500000", currency: "EUR" });
    const both = await as(M, wsA, (tx, ctx) =>
      createRate(
        tx,
        ctx,
        propA,
        rate(d(75), d(78), { nightlyAmount: "7.000", weeklyAmount: "45.000" }),
      ),
    );
    expect(await rowOf(both)).toMatchObject({
      nightly: "700000",
      weekly: "4500000",
      currency: "EUR",
      created_by: M.id,
    });
  });

  it("iki fiyat da boş: uygulama ve veritabanı reddeder", async () => {
    await expect(
      as(O, wsA, (tx, ctx) =>
        createRate(tx, ctx, propA, rate(d(200), d(205), { nightlyAmount: "", weeklyAmount: "" })),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: { nightlyAmount: ["Gecelik veya haftalık fiyattan en az birini girin."] },
    });
    expect(
      await pgMessage(
        as(O, wsA, (tx) => rawInsert(tx, wsA, propA, d(200), d(205), { nightly: null })),
      ),
    ).toMatch(/property_rates_amounts/);
  });

  it("veritabanı kısıtları: tarih sırası, 366 gece, tutar, para birimi, minimum konaklama", async () => {
    const bad = (s: string, e: string, extra: Parameters<typeof rawInsert>[5]) =>
      pgMessage(as(O, wsA, (tx) => rawInsert(tx, wsA, propA, s, e, extra)));
    expect(await bad(d(300), d(300), {})).toMatch(/property_rates_dates/);
    expect(await bad(d(300), d(667), {})).toMatch(/property_rates_dates/);
    expect(await bad(d(300), d(301), { nightly: 0 })).toMatch(/property_rates_amounts/);
    expect(await bad(d(300), d(301), { nightly: 1_000_000_000_000 })).toMatch(
      /property_rates_amounts/,
    );
    expect(await bad(d(300), d(301), { currency: "JPY" })).toMatch(/property_rates_currency/);
    expect(await bad(d(300), d(301), { min: 0 })).toMatch(/property_rates_min_nights/);
    // Sınır değerler geçerli: 366 gece, en büyük tutar, 365 gece minimum.
    await as(O, wsA, (tx) =>
      rawInsert(tx, wsA, propA, d(300), d(666), { nightly: 999_999_999_999, min: 365 }),
    );
    await admin.query("delete from property_rates where property_id = $1 and start_date = $2", [
      propA,
      d(300),
    ]);
  });

  it("tarih penceresi: başlangıç 1 yıldan eski olamaz", async () => {
    await expect(
      as(O, wsA, (tx, ctx) => createRate(tx, ctx, propA, rate(d(-370), d(-360)))),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: { startDate: [expect.any(String)] },
    });
  });
});

describe("çakışma kuralları", () => {
  let first: string;
  beforeAll(async () => {
    // 1–16 Temmuz benzeri: [d(100), d(115))
    first = await as(O, wsA, (tx, ctx) => createRate(tx, ctx, propA, rate(d(100), d(115))));
  });

  it("kesişen dönem reddedilir (uygulama mesajı + veritabanı kısıtı)", async () => {
    await expect(
      as(O, wsA, (tx, ctx) => createRate(tx, ctx, propA, rate(d(110), d(120)))),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: { startDate: [expect.stringMatching(/mevcut fiyat dönemiyle çakışıyor/)] },
    });
    for (const [s, e] of [
      [d(110), d(120)],
      [d(95), d(101)],
      [d(105), d(106)],
      [d(90), d(130)],
    ] as const) {
      expect(await pgCode(as(O, wsA, (tx) => rawInsert(tx, wsA, propA, s, e))), `${s}–${e}`).toBe(
        "23P01",
      );
    }
  });

  it("bitişik dönemler kabul edilir (bitiş = sonraki başlangıç)", async () => {
    const after = await as(O, wsA, (tx, ctx) => createRate(tx, ctx, propA, rate(d(115), d(130))));
    const before = await as(O, wsA, (tx, ctx) => createRate(tx, ctx, propA, rate(d(95), d(100))));
    const list = await as(S, wsA, (tx) => listRates(tx, propA));
    const ids = list.map((r) => r.id);
    expect(ids.indexOf(before)).toBeLessThan(ids.indexOf(first));
    expect(ids.indexOf(first)).toBeLessThan(ids.indexOf(after));
    // Sıralı: başlangıca göre artan.
    expect(list.map((r) => r.startDate)).toEqual([...list.map((r) => r.startDate)].sort());
  });

  it("farklı mülklerde aynı tarihler serbest (aynı işletme ve başka işletme)", async () => {
    await as(O, wsA, (tx, ctx) => createRate(tx, ctx, propA2, rate(d(100), d(115))));
    await as(B, wsB, (tx, ctx) => createRate(tx, ctx, propB, rate(d(100), d(115))));
  });

  it("düzenleme: kendisiyle çakışmaz; başka dönemin tarihine taşınamaz", async () => {
    // Yalnız fiyat değişikliği
    const r1 = await as(O, wsA, (tx, ctx) =>
      updateRate(tx, ctx, first, rate(d(100), d(115), { nightlyAmount: "6.000" })),
    );
    expect(r1).toEqual({ changed: 1, propertyId: propA });
    // Kendi aralığı içinde daraltma/kaydırma
    await as(O, wsA, (tx, ctx) =>
      updateRate(tx, ctx, first, rate(d(101), d(115), { nightlyAmount: "6.000" })),
    );
    await as(O, wsA, (tx, ctx) =>
      updateRate(tx, ctx, first, rate(d(100), d(115), { nightlyAmount: "6.000" })),
    );
    // Sonraki dönemin içine uzatma
    await expect(
      as(O, wsA, (tx, ctx) =>
        updateRate(tx, ctx, first, rate(d(100), d(116), { nightlyAmount: "6.000" })),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await rowOf(first)).toMatchObject({ s: d(100), e: d(115), nightly: "600000" });
    // Değişiklik yoksa güncelleme yapılmaz
    expect(
      await as(O, wsA, (tx, ctx) =>
        updateRate(tx, ctx, first, rate(d(100), d(115), { nightlyAmount: "6.000,00" })),
      ),
    ).toEqual({ changed: 0, propertyId: propA });
    const upd = (await auditOf(wsA, "property.rate_updated")).filter((a) => a.target_id === first);
    expect(upd.map((a) => a.metadata.fields)).toEqual([["nightly_amount"], ["dates"], ["dates"]]);
  });

  it("silinen dönemin tarihleri yeniden tanımlanabilir", async () => {
    await expect(
      as(O, wsA, (tx, ctx) => createRate(tx, ctx, propA, rate(d(100), d(115)))),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await as(M, wsA, (tx, ctx) => deleteRate(tx, ctx, first));
    expect(await rowOf(first)).toBeUndefined();
    const again = await as(O, wsA, (tx, ctx) =>
      createRate(tx, ctx, propA, rate(d(100), d(115), { weeklyAmount: "40.000" })),
    );
    expect(await rowOf(again)).toMatchObject({ s: d(100), e: d(115), weekly: "4000000" });
    expect((await auditOf(wsA, "property.rate_deleted")).map((a) => a.target_id)).toContain(first);
  });

  // Aynı mülke aynı anda kesişen iki dönem: en fazla biri kalır. (REPEATABLE READ'de yazma 0019
  // tetikleyicisiyle tümden reddedilir; ayrıca "tek para birimi" bölümünde sınanır.)
  for (const iso of ["read committed", "serializable"] as const) {
    it(`eşzamanlı ekleme — ${iso}: yalnız biri commit edilir`, async () => {
      const key = iso.split(" ")[0]!;
      const [u1, u2] = await Promise.all([mkUser(`fe1${key}`), mkUser(`fe2${key}`)]);
      const wsx = await mkWorkspace(u1, `fe-${key}`);
      await as(u1, wsx, (tx, ctx) =>
        addWorkspaceMember(tx, ctx, { userId: u2.id, role: "manager" }),
      );
      const px = await mkProperty(u1, wsx);
      const c1 = new Client({ connectionString: db.appUrl });
      const c2 = new Client({ connectionString: db.appUrl });
      await Promise.all([c1.connect(), c2.connect()]);
      const ins = (c: Client, from: number, to: number) =>
        c.query(
          `insert into property_rates (id, workspace_id, property_id, start_date, end_date,
                                       nightly_amount_minor, currency, created_by)
           values ($1, app_current_workspace_id(), $2, $3::date, $4::date, 100000, 'EUR',
                   app_current_user_id())`,
          [uuidv7(), px, d(from), d(to)],
        );
      const outcome = (p: Promise<unknown>) =>
        p.then(
          () => "ok",
          (e: { code?: string; message?: string }) => `${e.code}:${e.message}`,
        );
      try {
        for (const [c, u] of [
          [c1, u1],
          [c2, u2],
        ] as const) {
          await c.query(`begin isolation level ${iso}`);
          await c.query(
            "select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
            [u.id, wsx],
          );
          await c.query("select count(*) from property_rates");
        }
        const pid2 = (await c2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
        const r1 = await outcome(ins(c1, 5, 20));
        const p2 = outcome(ins(c2, 10, 25));
        for (let i = 0; i < 100; i++) {
          const w = await admin.query(
            "select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'",
            [pid2],
          );
          if (w.rowCount) break;
          await new Promise((res) => setTimeout(res, 50));
        }
        const commit1 = await outcome(c1.query("commit"));
        const r2 = await p2;
        const commit2 = await outcome(c2.query(r2 === "ok" ? "commit" : "rollback"));
        const n = (
          await admin.query("select count(*)::int n from property_rates where property_id = $1", [
            px,
          ])
        ).rows[0].n;
        expect({ r1, commit1, n }).toEqual({ r1: "ok", commit1: "ok", n: 1 });
        expect(r2 === "ok" ? commit2 : r2).toMatch(/^(23P01|40001):/);
      } finally {
        await Promise.all([c1.end(), c2.end()]);
      }
    });
  }
});

describe("roller ve tenant izolasyonu", () => {
  let rid: string;
  beforeAll(async () => {
    rid = await as(O, wsA, (tx, ctx) => createRate(tx, ctx, propA, rate(d(400), d(410))));
  });

  it("manager ekler, düzenler, siler", async () => {
    const id = await as(M, wsA, (tx, ctx) => createRate(tx, ctx, propA, rate(d(420), d(425))));
    await as(M, wsA, (tx, ctx) =>
      updateRate(tx, ctx, id, rate(d(420), d(425), { nightlyAmount: "1" })),
    );
    await as(M, wsA, (tx, ctx) => deleteRate(tx, ctx, id));
    expect(await rowOf(id)).toBeUndefined();
  });

  it("staff görüntüler; ekleyemez, düzenleyemez, silemez (uygulama + veritabanı)", async () => {
    await as(S, wsA, async (tx, ctx) => {
      expect((await getRate(tx, rid))?.nightlyAmountMinor).toBe(500000);
      expect((await listRates(tx, propA)).length).toBeGreaterThan(0);
      await expect(createRate(tx, ctx, propA, rate(d(430), d(431)))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(updateRate(tx, ctx, rid, rate(d(400), d(410)))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(deleteRate(tx, ctx, rid)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
    expect(await pgMessage(as(S, wsA, (tx) => rawInsert(tx, wsA, propA, d(430), d(431))))).toMatch(
      /row-level security/,
    );
    const upd = await as(S, wsA, (tx) =>
      tx.execute(sql`update property_rates set nightly_amount_minor = 1 where id = ${rid}`),
    );
    const del = await as(S, wsA, (tx) =>
      tx.execute(sql`delete from property_rates where id = ${rid}`),
    );
    expect([upd.rowCount, del.rowCount]).toEqual([0, 0]);
    expect(await rowOf(rid)).toMatchObject({ nightly: "500000" });
  });

  it("başka işletmenin dönemleri görünmez, değiştirilemez, silinemez", async () => {
    await as(B, wsB, async (tx, ctx) => {
      expect(await getRate(tx, rid)).toBeNull();
      expect(await listRates(tx, propA)).toEqual([]);
      expect(await findRateConflicts(tx, propA, d(400), d(410))).toEqual([]);
      await expect(updateRate(tx, ctx, rid, rate(d(400), d(410)))).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(deleteRate(tx, ctx, rid)).rejects.toMatchObject({ code: "NOT_FOUND" });
      const u = await tx.execute(sql`update property_rates set currency = 'TRY' where id = ${rid}`);
      const x = await tx.execute(sql`delete from property_rates where id = ${rid}`);
      expect([u.rowCount, x.rowCount]).toEqual([0, 0]);
    });
    expect(await rowOf(rid)).toMatchObject({ currency: "EUR" });
  });

  it("başka işletmenin mülküne dönem eklenemez (uygulama, politika, bileşik FK)", async () => {
    await expect(
      as(O, wsA, (tx, ctx) => createRate(tx, ctx, propB, rate(d(400), d(410)))),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Kendi işletmesi adına, başka işletmenin mülkü → bileşik FK
    expect(await pgCode(as(O, wsA, (tx) => rawInsert(tx, wsA, propB, d(440), d(441))))).toBe(
      "23503",
    );
    // Başka işletme adına → RLS
    expect(await pgMessage(as(O, wsA, (tx) => rawInsert(tx, wsB, propB, d(440), d(441))))).toMatch(
      /row-level security/,
    );
  });

  it("başkası adına eklenemez; mülk ve işletme sonradan değiştirilemez", async () => {
    expect(
      await pgMessage(
        as(O, wsA, (tx) =>
          tx.execute(sql`
            insert into property_rates (id, workspace_id, property_id, start_date, end_date,
                                        nightly_amount_minor, currency, created_by)
            values (${uuidv7()}, ${wsA}, ${propA}, ${d(450)}, ${d(451)}, 1, 'EUR', ${M.id})`),
        ),
      ),
    ).toMatch(/row-level security/);
    expect(
      await pgMessage(
        as(O, wsA, (tx) =>
          tx.execute(sql`update property_rates set property_id = ${propA2} where id = ${rid}`),
        ),
      ),
    ).toMatch(/permission denied/);
  });

  it("pasif mülkün fiyatları yönetilebilir", async () => {
    await as(O, wsA, (tx, ctx) => setPropertyStatus(tx, ctx, propA2, "passive"));
    const id = await as(O, wsA, (tx, ctx) => createRate(tx, ctx, propA2, rate(d(500), d(505))));
    expect(await rowOf(id)).toMatchObject({ property_id: propA2 });
    await as(O, wsA, (tx, ctx) => setPropertyStatus(tx, ctx, propA2, "active"));
  });
});

describe("rezervasyon sistemi etkilenmez", () => {
  it("fiyat dönemi rezervasyon çakışmasından bağımsız; tutarlar değişmez", async () => {
    // Fiyat dönemi olmadan rezervasyon
    const free = await as(O, wsA, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "reservation",
        propertyId: propA2,
        checkIn: d(600),
        checkOut: d(603),
        guestName: "Fiyatsız Misafir",
        adults: "2",
        source: "direct",
      }),
    );
    expect((await getReservationAs(free))?.totalAmountMinor).toBeNull();

    // Aynı tarihlerde fiyat dönemi + rezervasyon: ikisi de var olur
    const rateId = await as(O, wsA, (tx, ctx) =>
      createRate(tx, ctx, propA2, rate(d(600), d(610), { nightlyAmount: "9.000" })),
    );
    const res = await as(O, wsA, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "reservation",
        propertyId: propA2,
        checkIn: d(605),
        checkOut: d(607),
        guestName: "Tutarlı Misafir",
        adults: "2",
        source: "direct",
        totalAmount: "12.000",
        currency: "EUR",
      }),
    );
    // Fiyat değişse de mevcut rezervasyon tutarı aynı kalır
    await as(O, wsA, (tx, ctx) =>
      updateRate(tx, ctx, rateId, rate(d(600), d(610), { nightlyAmount: "20.000" })),
    );
    await as(O, wsA, (tx, ctx) => deleteRate(tx, ctx, rateId));
    const after = await getReservationAs(res);
    expect([after?.totalAmountMinor, after?.currency, after?.status]).toEqual([
      1200000,
      "EUR",
      "confirmed",
    ]);
    // Rezervasyon oluşturmak fiyat dönemi eklemez/değiştirmez
    const count = async () =>
      (
        await admin.query("select count(*)::int n from property_rates where property_id = $1", [
          propA2,
        ])
      ).rows[0].n as number;
    const n0 = await count();
    await as(O, wsA, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "block",
        propertyId: propA2,
        checkIn: d(620),
        checkOut: d(622),
      }),
    );
    expect(await count()).toBe(n0);
  });
});

const getReservationAs = (id: string) => as(O, wsA, (tx) => getReservation(tx, id));

describe("tek para birimi (0019)", () => {
  let W: U, ws: string, p1: string, p2: string;
  beforeAll(async () => {
    W = await mkUser("fpara");
    ws = await mkWorkspace(W, "fp");
    p1 = await mkProperty(W, ws);
    p2 = await mkExtraProperty(ws, W, "İkinci Ev");
  });

  it("ilk dönem para birimini belirler; farklı para birimiyle yeni dönem eklenemez", async () => {
    await as(W, ws, (tx, ctx) => createRate(tx, ctx, p1, rate(d(10), d(20), { currency: "GBP" })));
    expect(await as(W, ws, (tx) => propertyRateCurrency(tx, p1))).toBe("GBP");
    await expect(
      as(W, ws, (tx, ctx) => createRate(tx, ctx, p1, rate(d(20), d(30), { currency: "EUR" }))),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: {
        currency: [
          "Bu mülkün fiyat dönemleri GBP para biriminde; tüm dönemler aynı para biriminde olmalı.",
        ],
      },
    });
    // Veritabanı da reddeder (uygulama denetimi atlansa bile)
    expect(
      await pgMessage(as(W, ws, (tx) => rawInsert(tx, ws, p1, d(40), d(41), { currency: "EUR" }))),
    ).toBe("property_rates_currency_mismatch");
    // Aynı para birimi serbest; başka mülk kendi para birimini seçer
    await as(W, ws, (tx, ctx) => createRate(tx, ctx, p1, rate(d(20), d(30), { currency: "GBP" })));
    await as(W, ws, (tx, ctx) => createRate(tx, ctx, p2, rate(d(10), d(20), { currency: "TRY" })));
  });

  it("birden çok dönem varken para birimi değiştirilemez; tek dönemse değiştirilebilir", async () => {
    const [first] = await as(W, ws, (tx) => listRates(tx, p1));
    await expect(
      as(W, ws, (tx, ctx) =>
        updateRate(tx, ctx, first!.id, rate(d(10), d(20), { currency: "EUR" })),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: { currency: [expect.any(String)] },
    });
    expect(
      await pgMessage(
        as(W, ws, (tx) =>
          tx.execute(sql`update property_rates set currency = 'EUR' where id = ${first!.id}`),
        ),
      ),
    ).toBe("property_rates_currency_mismatch");
    const [only] = await as(W, ws, (tx) => listRates(tx, p2));
    await as(W, ws, (tx, ctx) =>
      updateRate(tx, ctx, only!.id, rate(d(10), d(20), { currency: "USD" })),
    );
    expect(await rowOf(only!.id)).toMatchObject({ currency: "USD" });
    // Tüm dönemler silinince yeni para birimi seçilebilir
    await as(W, ws, (tx, ctx) => deleteRate(tx, ctx, only!.id));
    await as(W, ws, (tx, ctx) => createRate(tx, ctx, p2, rate(d(50), d(55), { currency: "EUR" })));
  });

  it("REPEATABLE READ'de yazma reddedilir (kural garanti edilemez)", async () => {
    const c = new Client({ connectionString: db.appUrl });
    await c.connect();
    try {
      await c.query("begin isolation level repeatable read");
      await c.query(
        "select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
        [W.id, ws],
      );
      const r = await c
        .query(
          `insert into property_rates (id, workspace_id, property_id, start_date, end_date,
                                       nightly_amount_minor, currency, created_by)
           values ($1, app_current_workspace_id(), $2, $3::date, $4::date, 100, 'GBP',
                   app_current_user_id())`,
          [uuidv7(), p1, d(90), d(91)],
        )
        .then(
          () => "ok",
          (e: { message?: string }) => e.message,
        );
      expect(r).toBe("property_rates_currency_isolation");
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
  });

  // Boş mülke aynı anda iki farklı para birimiyle ilk dönem: advisory lock sayesinde biri reddedilir.
  for (const iso of ["read committed", "serializable"] as const) {
    it(`eşzamanlı ilk dönemler — ${iso}: farklı para birimi commit edilemez`, async () => {
      const key = iso.split(" ")[0]!;
      const [u1, u2] = await Promise.all([mkUser(`fc1${key}`), mkUser(`fc2${key}`)]);
      const wsx = await mkWorkspace(u1, `fc-${key}`);
      await as(u1, wsx, (tx, ctx) =>
        addWorkspaceMember(tx, ctx, { userId: u2.id, role: "manager" }),
      );
      const px = await mkProperty(u1, wsx);
      const c1 = new Client({ connectionString: db.appUrl });
      const c2 = new Client({ connectionString: db.appUrl });
      await Promise.all([c1.connect(), c2.connect()]);
      const ins = (c: Client, from: number, to: number, cur: string) =>
        c.query(
          `insert into property_rates (id, workspace_id, property_id, start_date, end_date,
                                       nightly_amount_minor, currency, created_by)
           values ($1, app_current_workspace_id(), $2, $3::date, $4::date, 100000, $5,
                   app_current_user_id())`,
          [uuidv7(), px, d(from), d(to), cur],
        );
      const outcome = (p: Promise<unknown>) =>
        p.then(
          () => "ok",
          (e: { code?: string; message?: string }) => `${e.code}:${e.message}`,
        );
      try {
        for (const [c, u] of [
          [c1, u1],
          [c2, u2],
        ] as const) {
          await c.query(`begin isolation level ${iso}`);
          await c.query(
            "select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
            [u.id, wsx],
          );
          await c.query("select count(*) from property_rates");
        }
        const pid2 = (await c2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
        // Kesişmeyen tarihler: yalnız para birimi kuralı devrede.
        const r1 = await outcome(ins(c1, 5, 10, "EUR"));
        const p2 = outcome(ins(c2, 20, 25, "TRY"));
        for (let i = 0; i < 100; i++) {
          const w = await admin.query(
            "select 1 from pg_stat_activity where pid = $1 and wait_event_type in ('Lock', 'Advisory')",
            [pid2],
          );
          if (w.rowCount) break;
          await new Promise((res) => setTimeout(res, 50));
        }
        const commit1 = await outcome(c1.query("commit"));
        const r2 = await p2;
        const commit2 = await outcome(c2.query(r2 === "ok" ? "commit" : "rollback"));
        const cur = (
          await admin.query(
            "select array_agg(distinct currency) c from property_rates where property_id = $1",
            [px],
          )
        ).rows[0].c;
        expect({ r1, commit1, cur }).toEqual({ r1: "ok", commit1: "ok", cur: ["EUR"] });
        expect(r2 === "ok" ? commit2 : r2).toMatch(
          /^(23514:property_rates_currency_mismatch|40001:)/,
        );
      } finally {
        await Promise.all([c1.end(), c2.end()]);
      }
    });
  }
});

describe("fiyat hesabı (salt okunur)", () => {
  let W: U, ws: string, p: string;
  beforeAll(async () => {
    W = await mkUser("fhesap");
    ws = await mkWorkspace(W, "fh");
    p = await mkProperty(W, ws);
    // A: [d10, d20) 5.000/35.000; B: [d20, d30) 7.000/45.000 min 5; C: [d30, d35) yalnız haftalık
    await as(W, ws, async (tx, ctx) => {
      await createRate(tx, ctx, p, rate(d(10), d(20), { weeklyAmount: "35.000", minNights: "3" }));
      await createRate(
        tx,
        ctx,
        p,
        rate(d(20), d(30), { nightlyAmount: "7.000", weeklyAmount: "45.000", minNights: "5" }),
      );
      await createRate(
        tx,
        ctx,
        p,
        rate(d(30), d(37), { nightlyAmount: "", weeklyAmount: "50.000" }),
      );
    });
  });

  it("dönemlere yayılan konaklama: haftalık blok dönem içinde; veritabanına yazmaz", async () => {
    const snapshot = async () =>
      (
        await admin.query(
          "select (select count(*) from property_rates)::int r, (select count(*) from reservations)::int s, (select count(*) from audit_log)::int a, (select max(updated_at) from property_rates) u",
        )
      ).rows[0];
    const before = await snapshot();
    const q = await as(W, ws, (tx) => quoteForProperty(tx, p, d(15), d(28))); // 5 + 8 gece
    expect(q).toMatchObject({
      ok: true,
      nights: 13,
      currency: "EUR",
      totalMinor: 25000_00 + 45000_00 + 7000_00,
    });
    expect(q!.segments.map((s) => [s.nights, s.weeks, s.extraNights])).toEqual([
      [5, 0, 5],
      [8, 1, 1],
    ]);
    expect(await snapshot()).toEqual(before);
  });

  it("minimum konaklama giriş dönemine göre uyarı; fiyatsız gece varsa toplam yok", async () => {
    expect((await as(W, ws, (tx) => quoteForProperty(tx, p, d(19), d(21))))!.minNights).toEqual({
      required: 3,
      periodId: expect.any(String),
    });
    const holes = await as(W, ws, (tx) => quoteForProperty(tx, p, d(33), d(40)));
    expect(holes).toMatchObject({ ok: false, totalMinor: null });
    expect(holes!.issues.map((i) => i.kind).sort()).toEqual(["nightly-missing", "unpriced"]);
  });

  it("staff hesaplayabilir; başka işletme göremez (veri sızmaz)", async () => {
    const st = await mkUser("fhstaff");
    await as(W, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: st.id, role: "staff" }));
    expect((await as(st, ws, (tx) => quoteForProperty(tx, p, d(10), d(17))))!.totalMinor).toBe(
      35000_00,
    );
    const other = await as(B, wsB, (tx) => quoteForProperty(tx, p, d(10), d(17)));
    expect(other).toMatchObject({ ok: false, segments: [], totalMinor: null });
  });

  it("geçersiz girdi: null", async () => {
    await as(W, ws, async (tx) => {
      expect(await quoteForProperty(tx, "x", d(10), d(12))).toBeNull();
      expect(await quoteForProperty(tx, p, d(12), d(12))).toBeNull();
      expect(await quoteForProperty(tx, p, d(1), d(400))).toBeNull();
    });
  });
});

describe("dahil bitiş tarihi (arayüz) → [başlangıç, bitiş) (veritabanı)", () => {
  it("1–30 Nisan ve 1–31 Mayıs: 30 + 31 gece, bitişik, boşluk ve çift fiyat yok", async () => {
    const W = await mkUser("fdahil");
    const ws = await mkWorkspace(W, "fd");
    const p = await mkProperty(W, ws);
    // Pencere içinde kalmak için bir sonraki yılın Nisan–Mayıs'ı.
    const y = Number(T.slice(0, 4)) + 1;
    const apr = await as(W, ws, (tx, ctx) =>
      createRate(tx, ctx, p, {
        startDate: `${y}-04-01`,
        lastNight: `${y}-04-30`,
        nightlyAmount: "5.000",
        currency: "TRY",
      }),
    );
    const may = await as(W, ws, (tx, ctx) =>
      createRate(tx, ctx, p, {
        startDate: `${y}-05-01`,
        lastNight: `${y}-05-31`,
        nightlyAmount: "6.000",
        currency: "TRY",
      }),
    );
    expect(await rowOf(apr)).toMatchObject({ s: `${y}-04-01`, e: `${y}-05-01` });
    expect(await rowOf(may)).toMatchObject({ s: `${y}-05-01`, e: `${y}-06-01` });
    // 30 Nisan gecesini Mayıs'a eklemeye çalışmak çakışır
    await expect(
      as(W, ws, (tx, ctx) =>
        createRate(tx, ctx, p, {
          startDate: `${y}-04-30`,
          lastNight: `${y}-04-30`,
          nightlyAmount: "1",
          currency: "TRY",
        }),
      ),
    ).rejects.toMatchObject({
      fieldErrors: { startDate: [expect.stringContaining(`1–30 Nisan ${y}`)] },
    });
    const q = await as(W, ws, (tx) => quoteForProperty(tx, p, `${y}-04-01`, `${y}-06-01`));
    expect(q).toMatchObject({ ok: true, nights: 61, totalMinor: 30 * 500000 + 31 * 600000 });
    expect(q!.segments.map((x) => [x.from, x.to, x.nights])).toEqual([
      [`${y}-04-01`, `${y}-05-01`, 30],
      [`${y}-05-01`, `${y}-06-01`, 31],
    ]);
    // Düzenleme: bitişi değiştirmeden fiyat güncelleme kendisiyle çakışmaz, tarihleri değiştirmez
    await as(W, ws, (tx, ctx) =>
      updateRate(tx, ctx, apr, {
        startDate: `${y}-04-01`,
        lastNight: `${y}-04-30`,
        nightlyAmount: "5.500",
        currency: "TRY",
      }),
    );
    expect(await rowOf(apr)).toMatchObject({ e: `${y}-05-01`, nightly: "550000" });
    const audits = (await auditOf(ws, "property.rate_updated")).map((a) => a.metadata.fields);
    expect(audits).toEqual([["nightly_amount"]]);
  });
});

describe("iş kuralı: 1–30 Nisan 5.000 TL ve rezervasyon geceleri", () => {
  it("1 Nis→1 May = 30 gece 150.000 TL; 1 Nis→30 Nis = 29 gece 145.000 TL", async () => {
    const W = await mkUser("fkural");
    const ws = await mkWorkspace(W, "fk");
    const p = await mkProperty(W, ws);
    const y = Number(T.slice(0, 4)) + 1;
    await as(W, ws, (tx, ctx) =>
      createRate(tx, ctx, p, {
        startDate: `${y}-04-01`,
        lastNight: `${y}-04-30`,
        nightlyAmount: "5.000",
        currency: "TRY",
      }),
    );
    const full = await as(W, ws, (tx) => quoteForProperty(tx, p, `${y}-04-01`, `${y}-05-01`));
    expect(full).toMatchObject({ ok: true, nights: 30, totalMinor: 150_000_00, issues: [] });
    const short = await as(W, ws, (tx) => quoteForProperty(tx, p, `${y}-04-01`, `${y}-04-30`));
    expect(short).toMatchObject({ ok: true, nights: 29, totalMinor: 145_000_00, issues: [] });
    // Rezervasyon tarih mantığı değişmedi: 1 Nis giriş, 1 May çıkış kaydı 30 gece
    const rid = await as(W, ws, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "reservation",
        propertyId: p,
        checkIn: `${y}-04-01`,
        checkOut: `${y}-05-01`,
        guestName: "Nisan Misafiri",
        adults: "2",
        source: "direct",
      }),
    );
    const r = await as(W, ws, (tx) => getReservation(tx, rid));
    expect([r?.checkIn, r?.checkOut, r?.nights]).toEqual([`${y}-04-01`, `${y}-05-01`, 30]);
  });
});

describe("temizlik ücreti (0020, 0021)", () => {
  let W: U, ws: string, p: string, y: number;
  beforeAll(async () => {
    W = await mkUser("ftemiz");
    ws = await mkWorkspace(W, "ft");
    p = await mkProperty(W, ws);
    y = Number(T.slice(0, 4)) + 1;
  });
  const apr = (over: Record<string, unknown> = {}) => ({
    startDate: `${y}-04-01`,
    lastNight: `${y}-04-30`,
    nightlyAmount: "5.000",
    currency: "TRY",
    ...over,
  });

  it("kaydedilir (kuruş), denetim kaydında yalnız alan adı; hesapta ayrı kalem", async () => {
    const id = await as(W, ws, (tx, ctx) =>
      createRate(tx, ctx, p, apr({ cleaningFee: "2.000", cleaningFeeFreeNights: "7" })),
    );
    expect(await rowOf(id)).toMatchObject({ cleaning: "200000", free_nights: 7 });
    const q6 = await as(W, ws, (tx) => quoteForProperty(tx, p, `${y}-04-01`, `${y}-04-07`));
    expect(q6).toMatchObject({
      ok: true,
      nights: 6,
      staySubtotalMinor: 30_000_00,
      cleaningFee: { amountMinor: 2_000_00, freeFromNights: 7 },
      totalMinor: 32_000_00,
    });
    const q7 = await as(W, ws, (tx) => quoteForProperty(tx, p, `${y}-04-01`, `${y}-04-08`));
    expect(q7).toMatchObject({ nights: 7, cleaningFee: null, totalMinor: 35_000_00 });
    const q8 = await as(W, ws, (tx) => quoteForProperty(tx, p, `${y}-04-01`, `${y}-04-09`));
    expect(q8).toMatchObject({ nights: 8, cleaningFee: null, totalMinor: 40_000_00 });

    await as(W, ws, (tx, ctx) =>
      updateRate(tx, ctx, id, apr({ cleaningFee: "2.500", cleaningFeeFreeNights: "7" })),
    );
    const upd = (await auditOf(ws, "property.rate_updated")).filter((a) => a.target_id === id);
    expect(upd.map((a) => a.metadata)).toEqual([{ property: p, fields: ["cleaning_fee"] }]);
    expect(JSON.stringify(upd)).not.toMatch(/2500|250000/);
    // Ücret kaldırılınca (boş) hesaptan çıkar
    await as(W, ws, (tx, ctx) => updateRate(tx, ctx, id, apr()));
    expect(await rowOf(id)).toMatchObject({ cleaning: null, free_nights: null });
    expect(
      (await as(W, ws, (tx) => quoteForProperty(tx, p, `${y}-04-01`, `${y}-04-03`)))!.cleaningFee,
    ).toBeNull();
    await as(W, ws, (tx, ctx) =>
      updateRate(tx, ctx, id, apr({ cleaningFee: "2.000", cleaningFeeFreeNights: "7" })),
    );
  });

  it("eski kayıt (temizlik kolonları olmadan eklenmiş) çalışmaya devam eder", async () => {
    await as(W, ws, (tx) =>
      tx.execute(sql`
        insert into property_rates (id, workspace_id, property_id, start_date, end_date,
                                    nightly_amount_minor, currency, created_by)
        values (${uuidv7()}, ${ws}, ${p}, ${`${y}-06-01`}, ${`${y}-07-01`}, 100000, 'TRY',
                app_current_user_id())`),
    );
    const q = await as(W, ws, (tx) => quoteForProperty(tx, p, `${y}-06-10`, `${y}-06-12`));
    expect(q).toMatchObject({ ok: true, totalMinor: 2_000_00, cleaningFee: null });
    const legacy = (await as(W, ws, (tx) => listRates(tx, p))).find(
      (r) => r.startDate === `${y}-06-01`,
    );
    expect(legacy).toMatchObject({ cleaningFeeMinor: null, cleaningFeeFreeNights: null });
  });

  it("veritabanı kısıtları: negatif ücret, ücretsiz sınır, aralık", async () => {
    const bad = (fee: number | null, free: number | null) =>
      pgMessage(
        as(W, ws, (tx) =>
          tx.execute(sql`
            insert into property_rates (id, workspace_id, property_id, start_date, end_date,
                                        nightly_amount_minor, currency, cleaning_fee_minor,
                                        cleaning_fee_free_nights, created_by)
            values (${uuidv7()}, ${ws}, ${p}, ${`${y}-08-01`}, ${`${y}-08-02`}, 1, 'TRY',
                    ${fee}, ${free}, app_current_user_id())`),
        ),
      );
    expect(await bad(-1, null)).toMatch(/constraint "property_rates_cleaning_fee"/);
    expect(await bad(null, 7)).toMatch(/property_rates_cleaning_fee_free_nights/);
    expect(await bad(100, 0)).toMatch(/property_rates_cleaning_fee_free_nights/);
    expect(await bad(1_000_000_000_000, null)).toMatch(/constraint "property_rates_cleaning_fee"/);
  });

  it("staff değiştiremez; başka işletme göremez ve hesaplayamaz", async () => {
    const st = await mkUser("ftstaff");
    await as(W, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: st.id, role: "staff" }));
    const [first] = await as(st, ws, (tx) => listRates(tx, p));
    expect(first!.cleaningFeeMinor).toBe(200000);
    await expect(
      as(st, ws, (tx, ctx) => updateRate(tx, ctx, first!.id, apr({ cleaningFee: "1" }))),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const u = await as(st, ws, (tx) =>
      tx.execute(sql`update property_rates set cleaning_fee_minor = 1 where id = ${first!.id}`),
    );
    expect(u.rowCount).toBe(0);
    const other = await as(B, wsB, (tx) => quoteForProperty(tx, p, `${y}-04-01`, `${y}-04-03`));
    expect(other).toMatchObject({ ok: false, totalMinor: null, cleaningFee: null });
    expect(await as(B, wsB, (tx) => getRate(tx, first!.id))).toBeNull();
  });
});

describe("yetkiler, politikalar, kısıtlar", () => {
  it("RLS ENABLE + FORCE; dört politika yalnız app_user için", async () => {
    const f = await admin.query(
      "select relrowsecurity r, relforcerowsecurity f from pg_class where relname = 'property_rates'",
    );
    expect(f.rows[0]).toEqual({ r: true, f: true });
    const p = await admin.query(
      "select policyname, cmd, roles::text[] as roles from pg_policies where tablename = 'property_rates' order by 1",
    );
    expect(p.rows.map((x) => [x.policyname, x.cmd, x.roles])).toEqual([
      ["property_rates_delete", "DELETE", ["app_user"]],
      ["property_rates_insert", "INSERT", ["app_user"]],
      ["property_rates_select", "SELECT", ["app_user"]],
      ["property_rates_update", "UPDATE", ["app_user"]],
    ]);
  });

  it("tablo/kolon yetkileri: yalnız app_user; korunan kolonlar güncellenemez", async () => {
    const t = await admin.query(`
      select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as rol, a.privilege_type
        from pg_class c, aclexplode(c.relacl) a
       where c.relname = 'property_rates' and a.grantee <> c.relowner order by 1, 2`);
    expect(t.rows).toEqual([
      { rol: "app_user", privilege_type: "DELETE" },
      { rol: "app_user", privilege_type: "SELECT" },
    ]);
    const cols = await admin.query(`
      select a.attname, x.privilege_type, x.grantee::regrole::text as rol
        from pg_attribute a, aclexplode(a.attacl) x
       where a.attrelid = 'property_rates'::regclass and a.attacl is not null
       order by 2, 1`);
    const byPriv = (p: string) =>
      cols.rows.filter((r) => r.privilege_type === p).map((r) => r.attname as string);
    expect(new Set(cols.rows.map((r) => r.rol))).toEqual(new Set(["app_user"]));
    expect(byPriv("UPDATE").sort()).toEqual(
      [
        "cleaning_fee_free_nights",
        "cleaning_fee_minor",
        "currency",
        "end_date",
        "min_nights",
        "nightly_amount_minor",
        "start_date",
        "weekly_amount_minor",
      ].sort(),
    );
    expect(byPriv("INSERT")).toEqual(
      expect.arrayContaining(["cleaning_fee_minor", "cleaning_fee_free_nights"]),
    );
    expect(byPriv("INSERT")).not.toContain("created_at");
    expect(byPriv("INSERT")).not.toContain("updated_at");
  });

  it("çakışma kısıtı ve updated_at tetikleyicisi tanımlı", async () => {
    const c = await admin.query(
      "select conname, contype from pg_constraint where conrelid = 'property_rates'::regclass and contype = 'x'",
    );
    expect(c.rows).toEqual([{ conname: "property_rates_no_overlap", contype: "x" }]);
    const id = await as(O, wsA, (tx, ctx) => createRate(tx, ctx, propA, rate(d(700), d(701))));
    const before = await rowOf(id);
    await new Promise((r) => setTimeout(r, 20));
    await as(O, wsA, (tx, ctx) =>
      updateRate(tx, ctx, id, rate(d(700), d(701), { minNights: "2" })),
    );
    const after = await rowOf(id);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(after.created_at.getTime()).toBe(before.created_at.getTime());
  });
});
