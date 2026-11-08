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
import { createMemoryTransport } from "@/lib/email/transports";
import { quoteStay } from "@/lib/pricing";
import { addDays, istanbulToday, requestReference } from "@/lib/reservation-meta";
import { photoPrefix } from "@/server/properties/photos";
import { publishProperty, updatePublicSlug } from "@/server/properties/public-profile";
import { createProperty } from "@/server/properties/service";
import { submitReservationRequest } from "@/server/public/reservation-request";
import { getPublicVilla } from "@/server/public/villa";
import {
  confirmReservation,
  countPendingWebRequests,
  getReservation,
  listReservations,
} from "@/server/reservations/service";
import { updateWorkspaceWhatsapp } from "@/server/workspaces/contact";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

/**
 * F3: villa sayfasından rezervasyon talebi (drizzle/0027) — gerçek PostgreSQL, app_user.
 * Talep mevcut reservations tablosuna beklemede + kaynak "web" yazılır; fiyat ve müsaitlik sunucuda
 * yeniden hesaplanır; tenant izolasyonu ve kişisel veri sızıntısı denetlenir.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 8 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const T = istanbulToday();
const d = (n: number) => addDays(T, n);
const OLD = Date.now() - 60_000;

type U = { id: string; email: string };
const mkUser = async (label: string, verified = true): Promise<U> => {
  const u = { id: uuidv7(), email: `${label}.${tag}@ornek.com` };
  await admin.query("insert into users (id, name, email, email_verified) values ($1, $2, $3, $4)", [
    u.id,
    `${label} K`,
    u.email,
    verified,
  ]);
  return u;
};
const as = <R>(u: U, ws: string, fn: (tx: Tx, ctx: TenantContext) => Promise<R>) =>
  withTenant(app, { userId: u.id, workspaceId: ws }, fn);

async function publishedVilla(owner: U, ws: string, slug: string, maxGuests = "6") {
  const prop = await as(owner, ws, (tx, ctx) =>
    createProperty(tx, ctx, {
      name: `Talep Villa ${slug}`,
      propertyType: "villa",
      maxGuests,
      bedrooms: "3",
      bathrooms: "2",
      province: "Antalya",
      district: "Kaş",
    }),
  );
  await as(owner, ws, async (tx) => {
    const id = uuidv7();
    await tx.execute(sql`
      insert into property_photos (id, workspace_id, property_id, created_by, storage_prefix, width,
                                   height, quality, bytes_400, bytes_1200, bytes_2000, is_cover)
      values (${id}, ${ws}, ${prop}, app_current_user_id(), ${photoPrefix(ws, prop, id)},
              1800, 1200, 82, 1, 1, 1, true)`);
  });
  await as(owner, ws, (tx, ctx) =>
    updatePublicSlug(tx, ctx, prop, { publicSlug: slug, confirmSlugChange: false }),
  );
  await as(owner, ws, (tx, ctx) => publishProperty(tx, ctx, prop));
  return prop;
}

/** Fiyat dönemi: gecelik 5.000 €, haftalık 30.000 €, min 3 gece, temizlik 200 € (7+ gece ücretsiz). */
const addRate = (
  owner: U,
  ws: string,
  prop: string,
  from: number,
  to: number,
  min: number | null = 3,
) =>
  as(owner, ws, (tx) =>
    tx.execute(sql`
      insert into property_rates (id, workspace_id, property_id, start_date, end_date,
                                  nightly_amount_minor, weekly_amount_minor, currency, min_nights,
                                  cleaning_fee_minor, cleaning_fee_free_nights, created_by)
      values (${uuidv7()}, ${ws}, ${prop}, ${d(from)}::date, ${d(to)}::date, 500000, 3000000,
              'EUR', ${min}, 20000, 7, app_current_user_id())`),
  );

const form = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  checkIn: d(10),
  checkOut: d(14),
  guests: 2,
  name: "Ayşe Yılmaz",
  phone: "0532 111 22 33",
  email: "Ayse@Ornek.com",
  note: "Geç saatte gireceğiz.",
  consent: true,
  website: "",
  openedAt: OLD,
  ...over,
});

const rowOf = async (id: string) =>
  (
    await admin.query(
      `select r.*, r.check_in::text ci, r.check_out::text co from reservations r
        where replace(r.id::text, '-', '') like '%' || lower($1)`,
      [id.replace("TLP-", "")],
    )
  ).rows;

let O: U, M: U, S: U, X: U, unverified: U;
let ws: string, wsX: string, prop: string, propX: string;
const slug = `talep-${tag}`;
const slugX = `talep-x-${tag}`;

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("rqowner");
  M = await mkUser("rqmanager");
  S = await mkUser("rqstaff");
  X = await mkUser("rqother");
  unverified = await mkUser("rqmanager2", false);
  ws = (await createWorkspace(app, { userId: O.id, name: "Talep İşletme", slug: `rq-${tag}` })).id;
  wsX = (await createWorkspace(app, { userId: X.id, name: "Diğer", slug: `rqx-${tag}` })).id;
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
  await as(O, ws, (tx, ctx) =>
    addWorkspaceMember(tx, ctx, { userId: unverified.id, role: "manager" }),
  );
  await as(O, ws, (tx, ctx) => updateWorkspaceWhatsapp(tx, ctx, "0532 000 11 22"));
  await as(X, wsX, (tx, ctx) => updateWorkspaceWhatsapp(tx, ctx, "0532 000 11 33"));
  prop = await publishedVilla(O, ws, slug, "6");
  propX = await publishedVilla(X, wsX, slugX, "4");
  await addRate(O, ws, prop, 0, 120);
});

afterAll(async () => {
  await admin.end();
  await appPool.end();
});

describe("geçerli talep", () => {
  it("beklemede + web kaydı; işletme ve villa sayfa adresinden; fiyat sunucuda; bildirim kişisel veri içermez", async () => {
    const mail = createMemoryTransport();
    const r = await submitReservationRequest(
      app,
      // İstemci tutar gönderse de kullanılmaz (şemada alan yok).
      { ...form(slug), totalMinor: 1, currency: "TRY", workspaceId: wsX, propertyId: propX },
      { email: { transport: mail, brand: "Kiralığım", appUrl: "https://app.test.invalid" } },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expected = quoteStay(d(10), d(14), (await getPublicVilla(app, null, slug))!.rates);
    expect(r).toMatchObject({
      checkIn: d(10),
      checkOut: d(14),
      guests: 2,
      totalMinor: expected.totalMinor,
      currency: "EUR",
    });
    // 4 gece × 5.000 € + temizlik 200 € (7 gecenin altında).
    expect(r.totalMinor).toBe(4 * 500000 + 20000);
    expect(r.reference).toMatch(/^TLP-[0-9A-F]{8}$/);

    const rows = await rowOf(r.reference);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      workspace_id: ws,
      property_id: prop,
      kind: "reservation",
      status: "pending",
      source: "web",
      ci: d(10),
      co: d(14),
      guest_name: "Ayşe Yılmaz",
      guest_phone: "+905321112233",
      guest_email: "ayse@ornek.com",
      adults: 2,
      children: 0,
      currency: "EUR",
      note: "Geç saatte gireceğiz.",
      created_by: null,
      deposit_amount_minor: null,
    });
    expect(Number(row.total_amount_minor)).toBe(4 * 500000 + 20000);
    expect(requestReference(row.id)).toBe(r.reference);

    // Bildirim: doğrulanmış sahip + yönetici; personel ve doğrulanmamış adres yok.
    await new Promise((res) => setTimeout(res, 50));
    expect(mail.outbox.map((m) => m.to).sort()).toEqual([M.email, O.email].sort());
    for (const m of mail.outbox) {
      expect(m.category).toBe("reservation.request");
      expect(`${m.subject} ${m.text} ${m.html}`).not.toMatch(/Ayşe|532|ornek\.com|Geç saatte|€/);
      expect(m.text).toContain(`/rezervasyonlar/${row.id}`);
      expect(m.text).toContain(r.reference);
    }
  });

  it("panelde görünür (owner/manager/staff); otomatik onaylanmaz; ev sahibi onaylayınca kesinleşir", async () => {
    const list = await as(S, ws, (tx) => listReservations(tx, { view: "upcoming" }));
    const item = list.items.find((x) => x.source === "web");
    expect(item).toMatchObject({ status: "pending", guestName: "Ayşe Yılmaz", propertyId: prop });
    expect(await as(O, ws, (tx) => countPendingWebRequests(tx))).toBe(1);
    // Başka işletme göremez.
    expect(await as(X, wsX, (tx) => getReservation(tx, item!.id))).toBeNull();
    expect(await as(X, wsX, (tx) => countPendingWebRequests(tx))).toBe(0);
    // Staff onaylayamaz; owner onaylar.
    const staffTry = await as(S, ws, (tx, ctx) => confirmReservation(tx, ctx, item!.id)).then(
      () => "ok",
      (e: { code?: string }) => e.code,
    );
    expect(staffTry).toBe("FORBIDDEN");
    await as(O, ws, (tx, ctx) => confirmReservation(tx, ctx, item!.id));
    expect((await as(O, ws, (tx) => getReservation(tx, item!.id)))?.status).toBe("confirmed");
    expect(await as(O, ws, (tx) => countPendingWebRequests(tx))).toBe(0);
  });

  it("talep takvimi kapatır (mevcut kural); public veri misafir bilgisini sızdırmaz", async () => {
    const v = await getPublicVilla(app, null, slug);
    expect(v!.busy).toContainEqual({ start: d(10), end: d(14) });
    expect(JSON.stringify(v)).not.toMatch(/Ayşe|5321112233|ornek\.com|Geç saatte|TLP-/);
  });

  it("fiyat hesaplanamazsa talep tutarsız kaydedilir (uydurma tutar yok)", async () => {
    // Fiyat dönemi yalnız 0–120. gün: 130. gün fiyatsız.
    const r = await submitReservationRequest(
      app,
      form(slug, { checkIn: d(130), checkOut: d(134) }),
    );
    expect(r).toMatchObject({ ok: true, totalMinor: null, currency: null });
    if (!r.ok) return;
    const row = (await rowOf(r.reference))[0];
    expect(row.total_amount_minor).toBeNull();
    expect(row.currency).toBeNull();
  });
});

describe("reddedilen talepler (hiçbir şey yazılmaz)", () => {
  const count = async () =>
    Number(
      (await admin.query("select count(*) from reservations where property_id = $1", [prop]))
        .rows[0].count,
    );

  it("minimum gece, dolu tarih, kapasite, geçmiş/uzun aralık", async () => {
    const before = await count();
    expect(
      await submitReservationRequest(app, form(slug, { checkIn: d(20), checkOut: d(22) })),
    ).toMatchObject({
      ok: false,
      code: "min_nights",
    });
    expect(
      await submitReservationRequest(app, form(slug, { checkIn: d(12), checkOut: d(16) })),
    ).toMatchObject({
      ok: false,
      code: "dates_unavailable",
    });
    expect(await submitReservationRequest(app, form(slug, { guests: 7 }))).toMatchObject({
      ok: false,
      code: "guests",
    });
    expect(
      await submitReservationRequest(app, form(slug, { checkIn: d(-2), checkOut: d(3) })),
    ).toMatchObject({
      ok: false,
      code: "dates_invalid",
    });
    expect(
      await submitReservationRequest(app, form(slug, { checkIn: d(30), checkOut: d(95) })),
    ).toMatchObject({
      ok: false,
      code: "dates_invalid",
    });
    expect(await count()).toBe(before);
  });

  it("form doğrulaması: zorunlu alanlar, telefon, onay, tuzak alan, çok hızlı gönderim", async () => {
    const before = await count();
    const bad = await submitReservationRequest(
      app,
      form(slug, { name: "", phone: "12", consent: false, email: "x@" }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe("invalid");
      expect(Object.keys(bad.fieldErrors ?? {}).sort()).toEqual([
        "consent",
        "email",
        "name",
        "phone",
      ]);
    }
    expect(
      await submitReservationRequest(app, form(slug, { website: "http://spam" })),
    ).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(
      await submitReservationRequest(app, form(slug, { openedAt: Date.now() }), {}),
    ).toMatchObject({ ok: false, code: "invalid" });
    expect(await count()).toBe(before);
  });

  it("yayında olmayan / bilinmeyen adres", async () => {
    expect(await submitReservationRequest(app, form("yok-boyle-villa"))).toMatchObject({
      ok: false,
      code: "not_found",
    });
    await admin.query("update properties set is_public = false where id = $1", [propX]);
    expect(
      await submitReservationRequest(app, form(slugX, { checkIn: d(40), checkOut: d(44) })),
    ).toMatchObject({ ok: false, code: "not_found" });
    await admin.query("update properties set is_public = true where id = $1", [propX]);
  });
});

describe("eşzamanlılık ve spam sınırı", () => {
  it("aynı tarihlere eşzamanlı iki talep: yalnız biri kaydedilir", async () => {
    const [a, b] = await Promise.all([
      submitReservationRequest(app, form(slugX, { checkIn: d(50), checkOut: d(54), guests: 2 })),
      submitReservationRequest(app, form(slugX, { checkIn: d(52), checkOut: d(56), guests: 2 })),
    ]);
    const oks = [a, b].filter((x) => x.ok);
    const fails = [a, b].filter((x) => !x.ok);
    expect(oks).toHaveLength(1);
    expect(fails[0]).toMatchObject({ code: "dates_unavailable" });
    const n = await admin.query(
      "select count(*) from reservations where property_id = $1 and source = 'web' and status = 'pending'",
      [propX],
    );
    expect(Number(n.rows[0].count)).toBe(1);
  });

  it("villa başına saatlik sınır: 5'ten sonrası reddedilir (veritabanında)", async () => {
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(
        await submitReservationRequest(
          app,
          form(slugX, { checkIn: d(60 + i * 3), checkOut: d(62 + i * 3), guests: 1 }),
        ),
      );
    }
    // Önceki testte 1 talep alındı: 4 kabul, sonrası sınır.
    expect(results.filter((r) => r.ok)).toHaveLength(4);
    expect(results.at(-1)).toMatchObject({ ok: false, code: "rate_limited" });
  });
});

describe("veritabanı güvenliği", () => {
  it("app_user public bağlamda tabloya doğrudan yazamaz; fonksiyon yalnız app_user'a açık", async () => {
    const direct = await app
      .transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', '', true), set_config('app.workspace_id', '', true),
                                    set_config('app.public_request', 'on', true)`);
        await tx.execute(sql`
          insert into reservations (id, workspace_id, property_id, kind, status, source, check_in,
                                    check_out, guest_name, adults, children)
          values (${uuidv7()}, ${ws}, ${prop}, 'reservation', 'pending', 'web', ${d(100)}::date,
                  ${d(103)}::date, 'Sızma', 1, 0)`);
      })
      .then(
        () => "ok",
        (e: unknown) => pgErrorInfo(e).code,
      );
    // Tetikleyici mülkü göremez (FK hatası) ya da RLS reddeder: her durumda kayıt yazılmaz.
    expect(["42501", "23503"]).toContain(direct);
    const leaked = await admin.query(
      "select count(*) from reservations where guest_name = 'Sızma'",
    );
    expect(Number(leaked.rows[0].count)).toBe(0);
    const grants = await admin.query(`
      select r.rolname, has_function_privilege(r.rolname,
        'public.app_public_reservation_request(uuid,text,date,date,integer,text,text,text,text,bigint,text)',
        'EXECUTE') as ok
        from pg_roles r where r.rolname in ('app_user', 'app_worker', 'app_admin') order by 1`);
    expect(grants.rows).toEqual([
      { rolname: "app_admin", ok: false },
      { rolname: "app_user", ok: true },
      { rolname: "app_worker", ok: false },
    ]);
  });

  it("fonksiyon doğrudan çağrılsa da kapasite, tarih ve görünürlük veritabanında denetlenir", async () => {
    const call = (over: Partial<Record<string, unknown>>) => {
      const p = {
        slug,
        ci: d(200),
        co: d(203),
        guests: 2,
        ...over,
      };
      return app
        .transaction((tx) =>
          tx.execute(sql`select * from app_public_reservation_request(${uuidv7()}::uuid,
            ${p.slug as string}, ${p.ci as string}::date, ${p.co as string}::date, ${p.guests as number}::int,
            'Doğrudan Çağrı', '+905320000000', null, null, null, null)`),
        )
        .then(
          () => "ok",
          (e: unknown) => pgErrorInfo(e).message,
        );
    };
    expect(await call({ guests: 7 })).toBe("public_request_guests");
    expect(await call({ ci: d(-1), co: d(2) })).toBe("public_request_dates");
    expect(await call({ ci: d(200), co: d(270) })).toBe("public_request_dates");
    expect(await call({ slug: "yok-boyle" })).toBe("public_request_not_found");
  });
});
