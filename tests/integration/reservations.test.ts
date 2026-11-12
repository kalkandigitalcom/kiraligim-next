import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import { pgErrorInfo } from "@/db/pg-error";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant, withUser } from "@/db/tenant";
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import { createProperty, setPropertyStatus } from "@/server/properties/service";
import {
  cancelReservation,
  confirmReservation,
  createReservation,
  findConflicts,
  getReservation,
  listCalendarEntries,
  listReservations,
  updateReservation,
} from "@/server/reservations/service";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

/**
 * Aşama 3.0a: rezervasyonlar ve bloklar (0015, 0016) — gerçek PostgreSQL. Uygulama işlemleri
 * yalnız app_user ile; yönetici bağlantısı kurulum ve doğrulama içindir. Tarihler bugüne
 * (Europe/Istanbul) göre seçilir; veritabanı tetikleyicisi de aynı "bugün"ü kullanır.
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
const mkProperty = (u: U, ws: string, maxGuests = "6") =>
  withTenant(app, { userId: u.id, workspaceId: ws }, (tx, ctx) =>
    createProperty(tx, ctx, {
      name: "Deniz Villa",
      propertyType: "villa",
      maxGuests,
      bedrooms: "3",
      bathrooms: "2",
      province: "Antalya",
      district: "Kaş",
    }),
  );
const as = <T>(u: U, ws: string, fn: (tx: Tx, ctx: TenantContext) => Promise<T>) =>
  withTenant(app, { userId: u.id, workspaceId: ws }, fn);

const guest = (over: Record<string, unknown> = {}) => ({
  kind: "reservation",
  guestName: "Ayşe Yılmaz",
  guestPhone: "+90 532 123 45 67",
  guestEmail: "ayse@ornek.com",
  adults: "2",
  children: "1",
  source: "airbnb",
  ...over,
});

/** Uygulama denetimini atlayan ham ekleme (yalnız veritabanı kuralları). */
const rawInsert = (
  tx: Tx,
  ws: string,
  property: string,
  checkIn: string,
  checkOut: string,
  extra: { kind?: string; status?: string } = {},
) =>
  tx.execute(sql`
    insert into reservations (id, workspace_id, property_id, kind, status, source, check_in, check_out,
                              guest_name, adults, children, created_by)
    values (${uuidv7()}, ${ws}, ${property}, ${extra.kind ?? "reservation"},
            ${extra.status ?? "confirmed"}, ${extra.kind === "block" ? null : "direct"},
            ${checkIn}, ${checkOut}, ${extra.kind === "block" ? null : "Ham Misafir"},
            ${extra.kind === "block" ? null : 2}, ${extra.kind === "block" ? null : 0},
            app_current_user_id())`);

const rowOf = async (id: string) =>
  (
    await admin.query(
      `select kind, status, source, to_char(check_in, 'YYYY-MM-DD') check_in,
              to_char(check_out, 'YYYY-MM-DD') check_out, guest_name, guest_phone, guest_email,
              adults, children, total_amount_minor::text total, deposit_amount_minor::text deposit,
              balance_amount_minor::text balance, currency, note, cancelled_at, cancelled_by,
              cancel_reason, created_by, workspace_id, property_id
         from reservations where id = $1`,
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
let wsA: string, wsB: string, propA: string, propB: string;

beforeAll(async () => {
  await admin.connect();
  [O, M, S, B] = (await Promise.all(["roya", "rmert", "rselin", "rbaris"].map(mkUser))) as [
    U,
    U,
    U,
    U,
  ];
  wsA = await mkWorkspace(O, "ra");
  wsB = await mkWorkspace(B, "rb");
  await as(O, wsA, async (tx, ctx) => {
    await addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" });
    await addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" });
  });
  propA = await mkProperty(O, wsA);
  propB = await mkProperty(B, wsB);
});

afterAll(async () => {
  await admin.end();
  await appPool.end();
});

describe("oluşturma", () => {
  it("rezervasyon: alanlar normalleştirilir, tutar kuruş, kalan tutar veritabanında hesaplanır", async () => {
    const id = await as(O, wsA, (tx, ctx) =>
      createReservation(
        tx,
        ctx,
        guest({
          propertyId: propA,
          checkIn: d(10),
          checkOut: d(14),
          status: "pending",
          totalAmount: "12.500,50",
          depositAmount: "2.500",
          currency: "EUR",
          note: "Geç giriş",
        }),
      ),
    );
    expect(await rowOf(id)).toMatchObject({
      kind: "reservation",
      status: "pending",
      source: "airbnb",
      check_in: d(10),
      check_out: d(14),
      guest_name: "Ayşe Yılmaz",
      guest_phone: "+90 532 123 45 67",
      guest_email: "ayse@ornek.com",
      adults: 2,
      children: 1,
      total: "1250050",
      deposit: "250000",
      balance: "1000050",
      currency: "EUR",
      note: "Geç giriş",
      cancelled_at: null,
      created_by: O.id,
      workspace_id: wsA,
      property_id: propA,
    });
    const r = await as(S, wsA, (tx) => getReservation(tx, id));
    expect(r).toMatchObject({
      propertyName: "Deniz Villa",
      checkIn: d(10),
      checkOut: d(14),
      nights: 4,
      totalAmountMinor: 1250050,
      depositAmountMinor: 250000,
      balanceAmountMinor: 1000050,
      currency: "EUR",
    });
    expect((await auditOf(wsA, "reservation.created"))[0]).toEqual({
      actor_user_id: O.id,
      target_type: "reservation",
      target_id: id,
      metadata: { property: propA, kind: "reservation", status: "pending", source: "airbnb" },
    });
    // Onay
    expect(await as(M, wsA, (tx, ctx) => confirmReservation(tx, ctx, id))).toEqual({
      changed: true,
    });
    expect((await rowOf(id)).status).toBe("confirmed");
  });

  it("blok: yalnız tarih ve açıklama; misafir/tutar alanları boş, durum onaylı", async () => {
    const id = await as(M, wsA, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "block",
        propertyId: propA,
        checkIn: d(20),
        checkOut: d(22),
        note: "Bakım",
        guestName: "yok sayılır",
        totalAmount: "100",
      }),
    );
    expect(await rowOf(id)).toMatchObject({
      kind: "block",
      status: "confirmed",
      source: null,
      guest_name: null,
      adults: null,
      total: null,
      currency: null,
      balance: null,
      note: "Bakım",
    });
  });

  it("geçersiz form ve kapasite: alan hataları; kayıt eklenmez", async () => {
    const before = (await admin.query("select count(*)::int n from reservations")).rows[0].n;
    await expect(
      as(O, wsA, (tx, ctx) =>
        createReservation(tx, ctx, guest({ propertyId: propA, checkIn: d(30), checkOut: d(30) })),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: { checkOut: ["Çıkış tarihi giriş tarihinden sonra olmalı."] },
    });
    await expect(
      as(O, wsA, (tx, ctx) =>
        createReservation(
          tx,
          ctx,
          guest({ propertyId: propA, checkIn: d(30), checkOut: d(32), adults: "5", children: "2" }),
        ),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: { adults: ["Misafir sayısı mülk kapasitesini (6 kişi) aşamaz."] },
    });
    await expect(
      as(O, wsA, (tx, ctx) => createReservation(tx, ctx, guest({ kind: "x", propertyId: propA }))),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await admin.query("select count(*)::int n from reservations")).rows[0].n).toBe(before);
  });
});

describe("çakışma kuralları", () => {
  let W: U, ws: string, prop: string;
  beforeAll(async () => {
    W = await mkUser("cakisma");
    ws = await mkWorkspace(W, "rc");
    prop = await mkProperty(W, ws);
  });
  const create = (over: Record<string, unknown>) =>
    as(W, ws, (tx, ctx) => createReservation(tx, ctx, guest({ propertyId: prop, ...over })));

  it("çakışan rezervasyon reddedilir; mesajda çakışan tarihler var (misafir adı yok)", async () => {
    await create({ checkIn: d(40), checkOut: d(44) });
    const err = await create({ checkIn: d(42), checkOut: d(46) }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CONFLICT" });
    expect((err as Error).message).toMatch(/^Seçilen tarihler dolu: .+ \(onaylı rezervasyon\)\.$/);
    expect((err as Error).message).not.toContain("Ayşe");
  });

  it("çıkış günü başka kaydın giriş günü olabilir (her iki yönde)", async () => {
    await create({ checkIn: d(44), checkOut: d(46) });
    await create({ checkIn: d(38), checkOut: d(40) });
  });

  it("beklemede kayıt da tarihleri kapatır; blok ve rezervasyon aynı kurala tabi", async () => {
    await create({ checkIn: d(50), checkOut: d(52), status: "pending" });
    await expect(create({ checkIn: d(51), checkOut: d(53) })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("beklemede rezervasyon"),
    });
    await expect(
      as(W, ws, (tx, ctx) =>
        createReservation(tx, ctx, {
          kind: "block",
          propertyId: prop,
          checkIn: d(49),
          checkOut: d(51),
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await as(W, ws, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "block",
        propertyId: prop,
        checkIn: d(60),
        checkOut: d(63),
      }),
    );
    await expect(create({ checkIn: d(62), checkOut: d(64) })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("(blok)"),
    });
  });

  it("iptal edilen kayıt tarihleri yeniden açar", async () => {
    const id = await create({ checkIn: d(70), checkOut: d(73) });
    await expect(create({ checkIn: d(70), checkOut: d(73) })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await as(W, ws, (tx, ctx) => cancelReservation(tx, ctx, id, "Misafir vazgeçti"));
    await create({ checkIn: d(70), checkOut: d(73) });
  });

  it("farklı mülkte aynı tarihler serbest", async () => {
    await as(O, wsA, (tx, ctx) =>
      createReservation(tx, ctx, guest({ propertyId: propA, checkIn: d(40), checkOut: d(44) })),
    );
  });

  it("düzenleme: kendi aralığında kaydırma serbest; başkasıyla çakışma reddedilir", async () => {
    const id = await create({ checkIn: d(80), checkOut: d(84) });
    await create({ checkIn: d(86), checkOut: d(88) });
    const base = guest({ checkIn: d(81), checkOut: d(85) });
    expect(await as(W, ws, (tx, ctx) => updateReservation(tx, ctx, id, base))).toEqual({
      changed: 1,
    });
    await expect(
      as(W, ws, (tx, ctx) => updateReservation(tx, ctx, id, { ...base, checkOut: d(87) })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await rowOf(id)).check_out).toBe(d(85));
  });

  it("veritabanı: uygulama atlansa da çakışma engellenir (dışlama kısıtı)", async () => {
    await as(W, ws, (tx) => rawInsert(tx, ws, prop, d(100), d(103)));
    const e = await as(W, ws, (tx) => rawInsert(tx, ws, prop, d(102), d(105))).catch((x: unknown) =>
      pgErrorInfo(x),
    );
    expect(e).toMatchObject({ code: "23P01", constraint: "reservations_no_overlap" });
    await as(W, ws, (tx) => rawInsert(tx, ws, prop, d(103), d(105)));
  });

  it("findConflicts kendisini hariç tutar; takvim aralığı yalnız aktifleri döndürür", async () => {
    const id = await create({ checkIn: d(110), checkOut: d(112) });
    await as(W, ws, async (tx) => {
      expect(await findConflicts(tx, prop, d(110), d(112), id)).toEqual([]);
      expect((await findConflicts(tx, prop, d(111), d(113))).map((c) => c.id)).toEqual([id]);
      expect(await findConflicts(tx, prop, d(112), d(114))).toEqual([]);
    });
    await as(W, ws, (tx, ctx) => cancelReservation(tx, ctx, id));
    const cal = await as(W, ws, (tx) => listCalendarEntries(tx, prop, d(36), d(90)));
    expect(cal.every((r) => r.status !== "cancelled")).toBe(true);
    expect(cal.map((r) => [r.checkIn, r.checkOut])).toContainEqual([d(38), d(40)]);
    expect(cal.map((r) => r.kind)).toContain("block");
  });

  // İki yönetici aynı anda aynı tarihleri kaydeder: her izolasyon seviyesinde en fazla biri kalır.
  for (const iso of ["read committed", "repeatable read", "serializable"] as const) {
    it(`eşzamanlı ekleme — ${iso}: yalnız biri commit edilir`, async () => {
      const key = iso.split(" ")[0]!;
      const [u1, u2] = await Promise.all([mkUser(`re1${key}`), mkUser(`re2${key}`)]);
      const wsx = await mkWorkspace(u1, `re-${key}`);
      await as(u1, wsx, (tx, ctx) =>
        addWorkspaceMember(tx, ctx, { userId: u2.id, role: "manager" }),
      );
      const px = await mkProperty(u1, wsx);
      const c1 = new Client({ connectionString: db.appUrl });
      const c2 = new Client({ connectionString: db.appUrl });
      await Promise.all([c1.connect(), c2.connect()]);
      const ins = (c: Client, from: number, to: number) =>
        c.query(
          `insert into reservations (id, workspace_id, property_id, kind, status, source, check_in,
                                     check_out, guest_name, adults, children, created_by)
           values ($1, app_current_workspace_id(), $2, 'reservation', 'confirmed', 'direct',
                   $3::date, $4::date, 'Yarış', 2, 0, app_current_user_id())`,
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
          await c.query("select count(*) from reservations");
        }
        const pid2 = (await c2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
        const r1 = await outcome(ins(c1, 5, 9));
        const p2 = outcome(ins(c2, 7, 11));
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
          await admin.query("select count(*)::int n from reservations where property_id = $1", [px])
        ).rows[0].n;
        expect({ r1, commit1, n }).toEqual({ r1: "ok", commit1: "ok", n: 1 });
        expect(r2 === "ok" ? commit2 : r2).toMatch(/^(23P01|40001):/);
      } finally {
        await Promise.all([c1.end(), c2.end()]);
      }
    });
  }
});

describe("iptal ve düzenleme kuralları", () => {
  let W: U, ws: string, prop: string;
  beforeAll(async () => {
    W = await mkUser("iptal");
    ws = await mkWorkspace(W, "ri");
    prop = await mkProperty(W, ws, "4");
  });
  const create = (over: Record<string, unknown>) =>
    as(W, ws, (tx, ctx) => createReservation(tx, ctx, guest({ propertyId: prop, ...over })));

  it("iptal: zaman ve eden veritabanında yazılır; neden kaydedilir; denetim kaydı", async () => {
    const id = await create({ checkIn: d(5), checkOut: d(7) });
    expect(await as(W, ws, (tx, ctx) => cancelReservation(tx, ctx, id, "  Hastalık "))).toEqual({
      changed: true,
    });
    const r = await rowOf(id);
    expect(r.status).toBe("cancelled");
    expect(r.cancelled_at).toBeInstanceOf(Date);
    expect(r.cancelled_by).toBe(W.id);
    expect(r.cancel_reason).toBe("Hastalık");
    expect((await auditOf(ws, "reservation.status_changed")).at(-1)).toMatchObject({
      target_id: id,
      metadata: { property: prop, from: "confirmed", to: "cancelled" },
    });
    // Tekrar iptal: değişiklik yok
    expect(await as(W, ws, (tx, ctx) => cancelReservation(tx, ctx, id))).toEqual({
      changed: false,
    });
  });

  it("iptal edilen kayıt kesin: düzenlenemez, onaylanamaz, yeniden etkinleştirilemez (uygulama + veritabanı)", async () => {
    const id = await create({ checkIn: d(9), checkOut: d(11), status: "pending" });
    await as(W, ws, (tx, ctx) => cancelReservation(tx, ctx, id));
    await expect(
      as(W, ws, (tx, ctx) =>
        updateReservation(tx, ctx, id, guest({ checkIn: d(9), checkOut: d(12) })),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "İptal edilen kayıt değiştirilemez." });
    await expect(as(W, ws, (tx, ctx) => confirmReservation(tx, ctx, id))).rejects.toMatchObject({
      code: "CONFLICT",
      message: "İptal edilen kayıt yeniden etkinleştirilemez.",
    });
    for (const set of ["status = 'confirmed'", "note = 'x'", "cancel_reason = 'y'"]) {
      expect(
        await pgMessage(
          as(W, ws, (tx) =>
            tx.execute(sql.raw(`update reservations set ${set} where id = '${id}'`)),
          ),
        ),
        set,
      ).toBe("reservation_cancelled_immutable");
    }
  });

  it("iptal durumunda kayıt eklenemez; iptal bilgisi istemciden yazılamaz", async () => {
    expect(
      await pgMessage(
        as(W, ws, (tx) => rawInsert(tx, ws, prop, d(15), d(16), { status: "cancelled" })),
      ),
    ).toBe("reservation_insert_cancelled");
    const id = await create({ checkIn: d(17), checkOut: d(18) });
    for (const set of ["cancelled_at = now()", "cancelled_by = created_by"]) {
      expect(
        await pgMessage(
          as(W, ws, (tx) =>
            tx.execute(sql.raw(`update reservations set ${set} where id = '${id}'`)),
          ),
        ),
      ).toMatch(/permission denied/);
    }
    // İptal nedeni iptal olmadan yazılamaz (CHECK)
    expect(
      await pgMessage(
        as(W, ws, (tx) =>
          tx.execute(sql`update reservations set cancel_reason = 'x' where id = ${id}`),
        ),
      ),
    ).toMatch(/reservations_cancellation/);
  });

  it("korunan kolonlar: mülk, tür, işletme, oluşturan, tarih damgaları ve kalan tutar değiştirilemez", async () => {
    const id = await create({ checkIn: d(20), checkOut: d(21) });
    for (const col of [
      "property_id",
      "kind",
      "workspace_id",
      "created_by",
      "created_at",
      "updated_at",
      "id",
    ]) {
      expect(
        await pgMessage(
          as(W, ws, (tx) =>
            tx.execute(sql.raw(`update reservations set ${col} = ${col} where id = '${id}'`)),
          ),
        ),
        col,
      ).toMatch(/permission denied/);
    }
    expect(
      await pgMessage(
        as(W, ws, (tx) =>
          tx.execute(sql`update reservations set balance_amount_minor = 1 where id = ${id}`),
        ),
      ),
    ).toMatch(/permission denied|can only be updated to DEFAULT/);
    // Uygulama: düzenlemede mülk ve tür gönderilse de yok sayılır.
    await as(W, ws, (tx, ctx) =>
      updateReservation(
        tx,
        ctx,
        id,
        guest({ kind: "block", propertyId: propB, checkIn: d(20), checkOut: d(21), note: "Not" }),
      ),
    );
    expect(await rowOf(id)).toMatchObject({ kind: "reservation", property_id: prop, note: "Not" });
  });

  it("düzenleme: yalnız değişen alan adları denetlenir; değişiklik yoksa kayıt yok", async () => {
    const id = await create({ checkIn: d(24), checkOut: d(26) });
    const base = guest({ checkIn: d(24), checkOut: d(26) });
    expect(await as(W, ws, (tx, ctx) => updateReservation(tx, ctx, id, base))).toEqual({
      changed: 0,
    });
    expect(
      await as(W, ws, (tx, ctx) =>
        updateReservation(tx, ctx, id, {
          ...base,
          checkOut: d(27),
          guestName: "Mehmet Kaya",
          guestPhone: "",
          totalAmount: "5.000",
          currency: "TRY",
        }),
      ),
    ).toEqual({ changed: 5 });
    const audit = (await auditOf(ws, "reservation.updated")).at(-1);
    expect(audit.metadata).toEqual({
      property: prop,
      fields: ["dates", "guest_name", "guest_phone", "amounts", "currency"],
    });
    expect(JSON.stringify(audit)).not.toMatch(/Mehmet|Ayşe|5000|532/);
    expect(await rowOf(id)).toMatchObject({
      guest_name: "Mehmet Kaya",
      guest_phone: null,
      total: "500000",
      currency: "TRY",
    });
  });

  it("kapasite yalnız misafir sayısı değişince denetlenir (kapasite sonradan düşse de not düzeltilir)", async () => {
    const id = await create({ checkIn: d(30), checkOut: d(32), adults: "3", children: "1" });
    await admin.query("update properties set max_guests = 2 where id = $1", [prop]);
    try {
      await as(W, ws, (tx, ctx) =>
        updateReservation(
          tx,
          ctx,
          id,
          guest({ checkIn: d(30), checkOut: d(32), adults: "3", children: "1", note: "Not" }),
        ),
      );
      await expect(
        as(W, ws, (tx, ctx) =>
          updateReservation(
            tx,
            ctx,
            id,
            guest({ checkIn: d(30), checkOut: d(32), adults: "3", children: "0" }),
          ),
        ),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    } finally {
      await admin.query("update properties set max_guests = 4 where id = $1", [prop]);
    }
  });
});

describe("tarih penceresi ve pasif mülk", () => {
  let W: U, ws: string, prop: string;
  beforeAll(async () => {
    W = await mkUser("pencere");
    ws = await mkWorkspace(W, "rp");
    prop = await mkProperty(W, ws);
  });

  it("giriş tarihi: 1 yıl geri / 3 yıl ileri (uygulama + veritabanı)", async () => {
    const one = addDays(T, -1);
    const minDay = (
      await admin.query(
        "select ((now() at time zone 'Europe/Istanbul')::date - interval '1 year')::date::text d",
      )
    ).rows[0].d as string;
    const maxDay = (
      await admin.query(
        "select ((now() at time zone 'Europe/Istanbul')::date + interval '3 years')::date::text d",
      )
    ).rows[0].d as string;
    await as(W, ws, (tx, ctx) =>
      createReservation(
        tx,
        ctx,
        guest({ propertyId: prop, checkIn: minDay, checkOut: addDays(minDay, 2) }),
      ),
    );
    await as(W, ws, (tx, ctx) =>
      createReservation(
        tx,
        ctx,
        guest({ propertyId: prop, checkIn: maxDay, checkOut: addDays(maxDay, 2) }),
      ),
    );
    await as(W, ws, (tx, ctx) =>
      createReservation(
        tx,
        ctx,
        guest({ propertyId: prop, checkIn: one, checkOut: addDays(one, 3) }),
      ),
    );
    await expect(
      as(W, ws, (tx, ctx) =>
        createReservation(
          tx,
          ctx,
          guest({ propertyId: prop, checkIn: addDays(minDay, -1), checkOut: addDays(minDay, 1) }),
        ),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { checkIn: [expect.any(String)] } });
    expect(
      await pgMessage(
        as(W, ws, (tx) => rawInsert(tx, ws, prop, addDays(maxDay, 1), addDays(maxDay, 3))),
      ),
    ).toBe("reservation_date_out_of_range");
  });

  it("eski bir kayıt tarih değişmedikçe düzenlenir; tarih değişirse pencere uygulanır", async () => {
    const old = addDays(T, -500);
    const id = uuidv7();
    // Pencere dışındaki eski kayıt (ör. sınır yürürlüğe girmeden önce): tetikleyici atlanarak.
    await admin.query("begin");
    await admin.query("alter table reservations disable trigger reservations_guard");
    await admin.query(
      `insert into reservations (id, workspace_id, property_id, kind, status, source, check_in, check_out,
                                 guest_name, adults, children, created_by)
       values ($1, $2, $3, 'reservation', 'confirmed', 'direct', $4, $5, 'Eski Misafir', 2, 0, $6)`,
      [id, ws, prop, old, addDays(old, 3), W.id],
    );
    await admin.query("alter table reservations enable trigger reservations_guard");
    await admin.query("commit");
    await as(W, ws, (tx, ctx) =>
      updateReservation(
        tx,
        ctx,
        id,
        guest({
          guestName: "Eski Misafir",
          checkIn: old,
          checkOut: addDays(old, 3),
          note: "Fatura kesildi",
        }),
      ),
    );
    expect((await rowOf(id)).note).toBe("Fatura kesildi");
    await expect(
      as(W, ws, (tx, ctx) =>
        updateReservation(tx, ctx, id, guest({ checkIn: old, checkOut: addDays(old, 4) })),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await as(W, ws, (tx, ctx) => cancelReservation(tx, ctx, id));
  });

  it("pasif mülk: yeni kayıt yok (uygulama + veritabanı); mevcut kayıt düzenlenir ve iptal edilir", async () => {
    const id = await as(W, ws, (tx, ctx) =>
      createReservation(tx, ctx, guest({ propertyId: prop, checkIn: d(200), checkOut: d(203) })),
    );
    await as(W, ws, (tx, ctx) => setPropertyStatus(tx, ctx, prop, "passive"));
    try {
      await expect(
        as(W, ws, (tx, ctx) =>
          createReservation(
            tx,
            ctx,
            guest({ propertyId: prop, checkIn: d(210), checkOut: d(212) }),
          ),
        ),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "Pasif mülke yeni rezervasyon veya blok eklenemez.",
      });
      await expect(
        as(W, ws, (tx, ctx) =>
          createReservation(tx, ctx, {
            kind: "block",
            propertyId: prop,
            checkIn: d(210),
            checkOut: d(212),
          }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await pgMessage(as(W, ws, (tx) => rawInsert(tx, ws, prop, d(220), d(222))))).toBe(
        "reservation_property_inactive",
      );
      await as(W, ws, (tx, ctx) =>
        updateReservation(tx, ctx, id, guest({ checkIn: d(200), checkOut: d(204) })),
      );
      expect((await rowOf(id)).check_out).toBe(d(204));
      await as(W, ws, (tx, ctx) => cancelReservation(tx, ctx, id));
    } finally {
      await as(W, ws, (tx, ctx) => setPropertyStatus(tx, ctx, prop, "active"));
    }
  });

  it("deneme süresi bitmiş işletme rezervasyon yönetmeye devam eder", async () => {
    await admin.query(
      "update workspace_subscriptions set trial_ends_at = now() - interval '1 minute' where workspace_id = $1",
      [ws],
    );
    const id = await as(W, ws, (tx, ctx) =>
      createReservation(tx, ctx, guest({ propertyId: prop, checkIn: d(300), checkOut: d(302) })),
    );
    await as(W, ws, (tx, ctx) =>
      updateReservation(tx, ctx, id, guest({ checkIn: d(300), checkOut: d(303) })),
    );
    await as(W, ws, (tx, ctx) => cancelReservation(tx, ctx, id));
  });
});

describe("roller ve tenant izolasyonu", () => {
  let rid: string;
  beforeAll(async () => {
    rid = await as(O, wsA, (tx, ctx) =>
      createReservation(tx, ctx, guest({ propertyId: propA, checkIn: d(150), checkOut: d(152) })),
    );
  });

  it("staff görüntüler; ekleyemez, düzenleyemez, onaylayamaz, iptal edemez (uygulama + veritabanı)", async () => {
    await as(S, wsA, async (tx, ctx) => {
      expect((await getReservation(tx, rid))?.guestName).toBe("Ayşe Yılmaz");
      expect((await listReservations(tx, { view: "upcoming" })).items.length).toBeGreaterThan(0);
      await expect(
        createReservation(tx, ctx, guest({ propertyId: propA, checkIn: d(160), checkOut: d(161) })),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        updateReservation(tx, ctx, rid, guest({ checkIn: d(150), checkOut: d(152) })),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(confirmReservation(tx, ctx, rid)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(cancelReservation(tx, ctx, rid)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
    expect(await pgMessage(as(S, wsA, (tx) => rawInsert(tx, wsA, propA, d(165), d(166))))).toMatch(
      /row-level security/,
    );
    const upd = await as(S, wsA, (tx) =>
      tx.execute(sql`update reservations set status = 'cancelled' where id = ${rid}`),
    );
    expect(upd.rowCount).toBe(0);
    expect((await rowOf(rid)).status).toBe("confirmed");
  });

  it("kimse silemez (yetki yok); başkası adına eklenemez", async () => {
    expect(
      await pgMessage(
        as(O, wsA, (tx) => tx.execute(sql`delete from reservations where id = ${rid}`)),
      ),
    ).toMatch(/permission denied/);
    expect(
      await pgMessage(
        as(O, wsA, (tx) =>
          tx.execute(sql`
            insert into reservations (id, workspace_id, property_id, kind, status, check_in, check_out, created_by)
            values (${uuidv7()}, ${wsA}, ${propA}, 'block', 'confirmed', ${d(170)}, ${d(171)}, ${M.id})`),
        ),
      ),
    ).toMatch(/row-level security/);
  });

  it("başka işletmenin kayıtları görünmez ve değiştirilemez", async () => {
    await as(B, wsB, async (tx, ctx) => {
      expect(await getReservation(tx, rid)).toBeNull();
      expect((await listReservations(tx, { view: "upcoming" })).items).toEqual([]);
      expect(await listCalendarEntries(tx, propA, d(0), d(400))).toEqual([]);
      expect(await findConflicts(tx, propA, d(150), d(152))).toEqual([]);
      await expect(
        updateReservation(tx, ctx, rid, guest({ checkIn: d(150), checkOut: d(152) })),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(cancelReservation(tx, ctx, rid)).rejects.toMatchObject({ code: "NOT_FOUND" });
      const u = await tx.execute(sql`update reservations set note = 'x' where id = ${rid}`);
      expect(u.rowCount).toBe(0);
    });
  });

  it("başka işletmenin mülküne kayıt eklenemez (uygulama, tetikleyici, politika, bileşik FK)", async () => {
    await expect(
      as(O, wsA, (tx, ctx) =>
        createReservation(tx, ctx, guest({ propertyId: propB, checkIn: d(150), checkOut: d(152) })),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { propertyId: ["Mülk seçin."] } });
    // Kendi işletme kimliği + başkasının mülkü: tetikleyici mülkü göremez.
    expect(await pgMessage(as(O, wsA, (tx) => rawInsert(tx, wsA, propB, d(150), d(152))))).toBe(
      "reservation_property_not_found",
    );
    // Başka işletme kimliği: tetikleyici veya politika reddeder.
    expect(await pgMessage(as(O, wsA, (tx) => rawInsert(tx, wsB, propB, d(150), d(152))))).toMatch(
      /reservation_property_not_found|row-level security/,
    );
    // Tetikleyici atlansa bile bileşik FK aynı işletmeyi zorunlu kılar.
    await admin.query("begin");
    await admin.query("alter table reservations disable trigger reservations_guard");
    const fk = await admin
      .query(
        `insert into reservations (id, workspace_id, property_id, kind, status, check_in, check_out)
         values ($1, $2, $3, 'block', 'confirmed', $4, $5)`,
        [uuidv7(), wsA, propB, d(150), d(152)],
      )
      .then(
        () => "başarılı",
        (e: { message?: string }) => e.message ?? "",
      );
    await admin.query("rollback");
    expect(fk).toMatch(/reservations_property_fk/);
  });

  it("bağlam elle kurulsa bile üye olmayan göremez; bağlamsız hiçbir şey görünmez; askıdaki işletme kapalı", async () => {
    const r = await withUser(app, B.id, async (tx) => {
      await tx.execute(sql`select set_config('app.workspace_id', ${wsA}, true)`);
      return tx.execute(sql`select id from reservations`);
    });
    expect(r.rows).toEqual([]);
    expect(
      (await withUser(app, O.id, (tx) => tx.execute(sql`select id from reservations`))).rows,
    ).toEqual([]);
    const X = await mkUser("rxena");
    const ws = await mkWorkspace(X, "rx");
    const p = await mkProperty(X, ws);
    await as(X, ws, (tx, ctx) =>
      createReservation(tx, ctx, guest({ propertyId: p, checkIn: d(3), checkOut: d(4) })),
    );
    await admin.query("update workspaces set status = 'suspended' where id = $1", [ws]);
    await expect(
      as(X, ws, (tx) => listReservations(tx, { view: "upcoming" })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const raw = await withUser(app, X.id, async (tx) => {
      await tx.execute(sql`select set_config('app.workspace_id', ${ws}, true)`);
      return tx.execute(sql`select id from reservations`);
    });
    expect(raw.rows).toEqual([]);
  });
});

describe("listeler", () => {
  let W: U, ws: string, prop: string;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    W = await mkUser("liste");
    ws = await mkWorkspace(W, "rl");
    prop = await mkProperty(W, ws);
    const mk = (key: string, over: Record<string, unknown>) =>
      as(W, ws, (tx, ctx) => createReservation(tx, ctx, guest({ propertyId: prop, ...over }))).then(
        (id) => (ids[key] = id),
      );
    await mk("past", { checkIn: d(-10), checkOut: d(-7), guestName: "Geçmiş Misafir" });
    await mk("checkoutToday", { checkIn: d(-3), checkOut: d(0), guestName: "Bugün Çıkan" });
    await mk("current", { checkIn: d(0), checkOut: d(2), guestName: "Şimdi_Konaklayan %" });
    await mk("upcoming2", { checkIn: d(9), checkOut: d(10), guestName: "İleri İki" });
    await mk("upcoming1", {
      checkIn: d(5),
      checkOut: d(7),
      guestName: "İleri Bir",
      status: "pending",
    });
    await mk("cancelled", { checkIn: d(20), checkOut: d(22), guestName: "İptal Misafir" });
    await as(W, ws, (tx, ctx) => cancelReservation(tx, ctx, ids.cancelled!));
    await as(W, ws, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "block",
        propertyId: prop,
        checkIn: d(30),
        checkOut: d(31),
      }),
    );
  });
  const list = (opts: Parameters<typeof listReservations>[1]) =>
    as(W, ws, (tx) => listReservations(tx, opts)).then((r) => r.items.map((x) => x.id));

  it("görünümler: yaklaşan, konaklayan (çıkış günü hariç), geçmiş (çıkış günü dahil), iptal", async () => {
    expect(await list({ view: "upcoming", kind: "reservation" })).toEqual([
      ids.upcoming1,
      ids.upcoming2,
    ]);
    expect(await list({ view: "current" })).toEqual([ids.current]);
    expect(await list({ view: "past" })).toEqual([ids.checkoutToday, ids.past]);
    expect(await list({ view: "cancelled" })).toEqual([ids.cancelled]);
    expect((await list({ view: "upcoming" })).length).toBe(3); // blok dahil
  });

  it("arama (joker karakterler kaçışlı), mülk filtresi, sayfalama", async () => {
    expect(await list({ view: "upcoming", query: "ileri" })).toEqual([
      ids.upcoming1,
      ids.upcoming2,
    ]);
    expect(await list({ view: "current", query: "_konaklayan %" })).toEqual([ids.current]);
    expect(await list({ view: "upcoming", query: "%" })).toEqual([]);
    expect(await list({ view: "upcoming", propertyId: propA })).toEqual([]);
    expect(await list({ view: "upcoming", propertyId: "gecersiz" })).toEqual([]);
    const page = await as(W, ws, (tx) =>
      listReservations(tx, { view: "upcoming", kind: "reservation", limit: 1 }),
    );
    expect([page.items.map((x) => x.id), page.hasMore]).toEqual([[ids.upcoming1], true]);
    const page2 = await as(W, ws, (tx) =>
      listReservations(tx, { view: "upcoming", kind: "reservation", limit: 1, offset: 1 }),
    );
    expect([page2.items.map((x) => x.id), page2.hasMore]).toEqual([[ids.upcoming2], false]);
  });

  it("takvim aralığı: aralıkla kesişenler (çıkışı aralık başında olan hariç)", async () => {
    const cal = await as(W, ws, (tx) => listCalendarEntries(tx, prop, d(0), d(8)));
    expect(cal.map((r) => r.id)).toEqual([ids.current, ids.upcoming1]);
  });
});

describe("yetkiler, politikalar, kısıtlar, fonksiyon", () => {
  it("RLS ENABLE + FORCE; üç politika yalnız app_user için; DELETE politikası yok", async () => {
    const f = await admin.query(
      "select relrowsecurity r, relforcerowsecurity f from pg_class where relname = 'reservations'",
    );
    expect(f.rows[0]).toEqual({ r: true, f: true });
    const p = await admin.query(
      "select policyname, cmd, roles::text[] as roles from pg_policies where tablename = 'reservations' order by 1",
    );
    expect(p.rows.map((x) => [x.policyname, x.cmd, x.roles])).toEqual([
      // 0052: acente API'si müsaitlik fonksiyonu için dar SELECT (app.api_fn; yalnız beklemede/onaylı).
      ["reservations_api_fn", "SELECT", ["app_migrator"]],
      // 0029 (3.1): iCal dışa aktarma ve senkron çakışma sayımı için app_migrator'a dar SELECT
      // (yalnız app.ical_export / app.ical_sync açıkken; misafir kolonları fonksiyonlarda okunmaz).
      ["reservations_ical_export_read", "SELECT", ["app_migrator"]],
      ["reservations_ical_sync_read", "SELECT", ["app_migrator"]],
      ["reservations_insert", "INSERT", ["app_user"]],
      // 0024: public villa okuma fonksiyonları için app_migrator'a dar SELECT (yalnız app.public_read açıkken).
      ["reservations_public_read", "SELECT", ["app_migrator"]],
      // 0027 (F3): villa sayfası talebi için app_migrator'a dar INSERT (yalnız app.public_request açıkken).
      ["reservations_public_request", "INSERT", ["app_migrator"]],
      ["reservations_select", "SELECT", ["app_user"]],
      ["reservations_update", "UPDATE", ["app_user"]],
      // 0036 (A2): WhatsApp takvim önerisi worker'ının çakışma özeti için dar SELECT (app.wa_calendar).
      ["reservations_wa_calendar_read", "SELECT", ["app_migrator"]],
    ]);
  });

  it("tablo/kolon yetkileri: yalnız app_user; SELECT; DELETE yok; korunan kolonlar güncellenemez", async () => {
    const t = await admin.query(`
      select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as rol, a.privilege_type
        from pg_class c, aclexplode(c.relacl) a
       where c.relname = 'reservations' and a.grantee <> c.relowner order by 1, 2`);
    expect(t.rows).toEqual([{ rol: "app_user", privilege_type: "SELECT" }]);
    const cols = await admin.query(`
      select a.attname, x.privilege_type, x.grantee::regrole::text as rol
        from pg_attribute a, aclexplode(a.attacl) x
       where a.attrelid = 'reservations'::regclass and a.attacl is not null
       order by 2, 1`);
    const byPriv = (p: string) =>
      cols.rows.filter((r) => r.privilege_type === p).map((r) => r.attname as string);
    expect(new Set(cols.rows.map((r) => r.rol))).toEqual(new Set(["app_user"]));
    for (const c of [
      "cancelled_at",
      "cancelled_by",
      "balance_amount_minor",
      "created_at",
      "updated_at",
      "cancel_reason",
    ]) {
      expect(byPriv("INSERT"), c).not.toContain(c);
    }
    for (const c of [
      "id",
      "workspace_id",
      "property_id",
      "kind",
      "created_by",
      "created_at",
      "updated_at",
      "cancelled_at",
      "cancelled_by",
      "balance_amount_minor",
    ]) {
      expect(byPriv("UPDATE"), c).not.toContain(c);
    }
    expect(byPriv("UPDATE")).toEqual(
      expect.arrayContaining([
        "status",
        "check_in",
        "check_out",
        "guest_name",
        "note",
        "cancel_reason",
      ]),
    );
  });

  it("çakışma kısıtı: gist, mülk + [giriş, çıkış), yalnız beklemede/onaylı", async () => {
    const r = await admin.query(
      "select pg_get_constraintdef(oid) def from pg_constraint where conname = 'reservations_no_overlap'",
    );
    expect(r.rows[0].def).toBe(
      "EXCLUDE USING gist (property_id WITH =, daterange(check_in, check_out, '[)'::text) WITH &&) WHERE ((status = ANY (ARRAY['pending'::text, 'confirmed'::text])))",
    );
  });

  it("tetikleyici: SECURITY INVOKER, sabit search_path, EXECUTE kimsede yok", async () => {
    const r = await admin.query(`
      select prosecdef, pg_get_userbyid(proowner) owner, proconfig, proacl
        from pg_proc where proname = 'app_reservations_guard'`);
    expect(r.rows[0]).toMatchObject({
      prosecdef: false,
      owner: "app_migrator",
      proconfig: ["search_path=pg_catalog, pg_temp"],
    });
    expect(String(r.rows[0].proacl)).toBe("{app_migrator=X/app_migrator}");
    const t = await admin.query(`
      select tgname from pg_trigger where tgrelid = 'reservations'::regclass and not tgisinternal order by 1`);
    expect(t.rows.map((x) => x.tgname)).toEqual([
      "reservations_guard",
      // 0029 (3.1): harici takvim (iCal) çakışma tetikleyicisi — SECURITY DEFINER, çünkü F3 talebi
      // dahil her bağlamda olayları okuyabilmeli (tests/integration/ical.test.ts).
      "reservations_guard_external",
      "reservations_set_updated_at",
    ]);
    const ext = await admin.query(`
      select prosecdef, pg_get_userbyid(proowner) owner, proconfig, proacl
        from pg_proc where proname = 'app_reservations_external_guard'`);
    expect(ext.rows[0]).toMatchObject({
      prosecdef: true,
      owner: "app_migrator",
      proconfig: ["search_path=pg_catalog, pg_temp"],
    });
    expect(String(ext.rows[0].proacl)).toBe("{app_migrator=X/app_migrator}");
  });

  it("CHECK kısıtları: tutar, para birimi, blok alanları, tarih, telefon, e-posta", async () => {
    const W = await mkUser("rcheck");
    const ws = await mkWorkspace(W, "rk");
    const p = await mkProperty(W, ws);
    const bad = (cols: string, vals: string) =>
      pgMessage(
        as(W, ws, (tx) =>
          tx.execute(
            sql.raw(`insert into reservations (id, workspace_id, property_id, kind, status, check_in, check_out, created_by${cols})
                     values ('${uuidv7()}', '${ws}', '${p}', ${vals.split("|")[0]}, '${d(10)}', '${d(12)}', app_current_user_id()${vals.split("|")[1] ?? ""})`),
          ),
        ),
      );
    const res = "'reservation', 'confirmed'";
    const g = ", source, guest_name, adults, children";
    const gv = ", 'direct', 'Ayşe Y', 2, 0";
    expect(await bad(`${g}, total_amount_minor`, `${res}|${gv}, 100`)).toMatch(
      /reservations_amounts/,
    );
    expect(
      await bad(
        `${g}, total_amount_minor, deposit_amount_minor, currency`,
        `${res}|${gv}, 100, 101, 'TRY'`,
      ),
    ).toMatch(/reservations_amounts/);
    expect(await bad(`${g}, deposit_amount_minor, currency`, `${res}|${gv}, 10, 'TRY'`)).toMatch(
      /reservations_amounts/,
    );
    expect(await bad(`${g}, total_amount_minor, currency`, `${res}|${gv}, -1, 'TRY'`)).toMatch(
      /reservations_amounts/,
    );
    expect(await bad(`${g}, total_amount_minor, currency`, `${res}|${gv}, 100, 'JPY'`)).toMatch(
      /reservations_currency_check/,
    );
    expect(await bad(`${g}, guest_phone`, `${res}|${gv}, 'abc'`)).toMatch(
      /reservations_guest_phone_format/,
    );
    expect(await bad(`${g}, guest_email`, `${res}|${gv}, 'x@y'`)).toMatch(
      /reservations_guest_email_format/,
    );
    expect(await bad(``, `${res}|`)).toMatch(/reservations_reservation_fields/);
    expect(await bad(`, guest_name`, `'block', 'confirmed'|, 'X Y'`)).toMatch(
      /reservations_block_fields/,
    );
    expect(await bad(``, `'block', 'pending'|`)).toMatch(/reservations_block_fields/);
    expect(await bad(``, `'tatil', 'confirmed'|`)).toMatch(/reservations_kind_check/);
  });

  it("updated_at güncellemede yenilenir", async () => {
    const W = await mkUser("rupd");
    const ws = await mkWorkspace(W, "ru");
    const p = await mkProperty(W, ws);
    const id = await as(W, ws, (tx, ctx) =>
      createReservation(tx, ctx, { kind: "block", propertyId: p, checkIn: d(1), checkOut: d(2) }),
    );
    const before = (await admin.query("select updated_at from reservations where id = $1", [id]))
      .rows[0].updated_at as Date;
    await new Promise((r) => setTimeout(r, 20));
    await as(W, ws, (tx, ctx) => updateReservation(tx, ctx, id, { checkIn: d(1), checkOut: d(3) }));
    const after = (await admin.query("select updated_at from reservations where id = $1", [id]))
      .rows[0].updated_at as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});
