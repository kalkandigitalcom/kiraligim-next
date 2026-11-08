import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import { pgErrorInfo } from "@/db/pg-error";
import { withPublicRead } from "@/db/public";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { lastCheckInDay } from "@/lib/public-villa";
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import { photoPrefix } from "@/server/properties/photos";
import { publishProperty, updatePublicProfile } from "@/server/properties/public-profile";
import { createProperty, setPropertyStatus } from "@/server/properties/service";
import { getPublicVilla, PUBLIC_VILLA_KEYS } from "@/server/public/villa";
import { createMemoryStorage } from "@/server/storage/memory";
import { updateWorkspaceWhatsapp } from "@/server/workspaces/contact";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

/**
 * Aşama F2a: public villa okuma katmanı (0024) — gerçek PostgreSQL. Oturumsuz okuma YALNIZ
 * app_public_villa* fonksiyonlarıyla; tenant izolasyonu ve kişisel veri sızıntısı zorunlu testler.
 * Kurulum ve doğrulama yönetici bağlantısıyla; uygulama işlemleri app_user ile.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 6 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const storage = createMemoryStorage("https://img.test.invalid");
const tag = randomBytes(3).toString("hex");
const T = istanbulToday();
const d = (n: number) => addDays(T, n);

// Kişisel/iç veriler: hiçbiri public çıktıda bulunmamalı.
const SECRETS = {
  guestName: `Gizli Misafir ${tag}`,
  guestPhone: "+905009998877",
  guestEmail: `gizli.${tag}@ornek.com`,
  note: `İç not ${tag}`,
  blockNote: `Blok notu ${tag}`,
  cancelReason: `İptal nedeni ${tag}`,
  address: `Gizli Sokak No 7 ${tag}`,
  postal: "07580",
  lat: "36.2655",
  lng: "29.4138",
  license: `07-${tag}`,
  workspaceName: `Gizli İşletme ${tag}`,
};

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
const as = <T>(u: U, ws: string, fn: (tx: Tx, ctx: TenantContext) => Promise<T>) =>
  withTenant(app, { userId: u.id, workspaceId: ws }, fn);
const mkProperty = (u: U, ws: string, name: string) =>
  as(u, ws, (tx, ctx) =>
    createProperty(tx, ctx, {
      name,
      propertyType: "villa",
      maxGuests: "8",
      bedrooms: "4",
      bathrooms: "3",
      province: "Antalya",
      district: "Kaş",
      neighborhood: "Kalkan",
      tourismLicenseNo: SECRETS.license,
      description: "<p>Denize <strong>400 m</strong> mesafede villa.</p>",
      poolSwimming: "yes",
      poolSwimmingDepth: "1,60",
      poolSwimmingWidth: "4",
      poolSwimmingLength: "9",
      poolSwimmingProtected: "yes",
    }),
  ).then(async (id) => {
    await writeLegacySecrets(id);
    return id;
  });
/**
 * Revizyon 1. aşama: eski kolonlar (açık adres, posta kodu, koordinat, yatak) uygulamadan
 * yazılamaz ama veritabanında durur. Sızıntı denetimi anlamlı kalsın diye gizli değerler doğrudan
 * yazılır; misafir sayfasına/önizlemeye hiçbiri çıkmamalı. (2. aşamada kolonlar kaldırılır.)
 */
const writeLegacySecrets = (id: string) =>
  admin.query(
    `update properties set address_line = $2, postal_code = $3, latitude = $4, longitude = $5,
            beds_double = 3, beds_single = 2 where id = $1`,
    [id, SECRETS.address, SECRETS.postal, SECRETS.lat, SECRETS.lng],
  );
const addPhoto = (u: U, ws: string, property: string, cover = false) =>
  as(u, ws, async (tx) => {
    const id = uuidv7();
    await tx.execute(sql`
      insert into property_photos (id, workspace_id, property_id, created_by, storage_prefix, width,
                                   height, quality, bytes_400, bytes_1200, bytes_2000, is_cover)
      values (${id}, ${ws}, ${property}, app_current_user_id(), ${photoPrefix(ws, property, id)},
              1800, 1200, 82, 1, 1, 1, ${cover})`);
  });
const res = (
  ws: string,
  prop: string,
  by: U,
  ci: string,
  co: string,
  o: { kind?: "block"; status?: "pending" | "confirmed" | "cancelled" } = {},
) =>
  o.kind === "block"
    ? admin.query(
        `insert into reservations (id, workspace_id, property_id, kind, status, check_in, check_out, note, created_by)
         values ($1,$2,$3,'block','confirmed',$4,$5,$6,$7)`,
        [uuidv7(), ws, prop, ci, co, SECRETS.blockNote, by.id],
      )
    : admin.query(
        `insert into reservations (id, workspace_id, property_id, kind, status, source, check_in, check_out,
           guest_name, guest_phone, guest_email, adults, children, total_amount_minor, currency, note, created_by)
         values ($1,$2,$3,'reservation',$4,'direct',$5,$6,$7,$8,$9,2,0,4242400,'TRY',$10,$11)`,
        [
          uuidv7(),
          ws,
          prop,
          o.status ?? "confirmed",
          ci,
          co,
          SECRETS.guestName,
          SECRETS.guestPhone,
          SECRETS.guestEmail,
          SECRETS.note,
          by.id,
        ],
      );
const rate = (ws: string, prop: string, by: U, s: string, e: string, nightly: number) =>
  admin.query(
    `insert into property_rates (id, workspace_id, property_id, start_date, end_date, nightly_amount_minor,
       weekly_amount_minor, currency, min_nights, cleaning_fee_minor, cleaning_fee_free_nights, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,'TRY',3,250000,7,$8)`,
    [uuidv7(), ws, prop, s, e, nightly * 100, nightly * 600, by.id],
  );
const publish = async (u: U, ws: string, prop: string, slug: string) => {
  await as(u, ws, (tx, ctx) =>
    updatePublicProfile(tx, ctx, prop, {
      publicSlug: slug,
      amenities: ["wifi", "otopark"],
      checkInTime: "16:00",
      checkOutTime: "10:00",
      houseRules: "Sessizlik 23:00.",
      cancellationPolicy: "30 gün önce ücretsiz.",
      paymentTerms: "%30 ön ödeme.",
    }),
  );
  await as(u, ws, (tx, ctx) => publishProperty(tx, ctx, prop));
};
const villa = (slug: string) => getPublicVilla(app, storage, slug, T);
const fn = async <R>(q: ReturnType<typeof sql>) =>
  (await withPublicRead(app, (tx) => tx.execute<R & Record<string, unknown>>(q))).rows;

let O: U, S: U, B: U;
let wsA: string, wsB: string, propA: string, propB: string;
const slugA = `villa-a-${tag}`;
const slugB = `villa-b-${tag}`;

beforeAll(async () => {
  await admin.connect();
  // Tek yönetici istemcisi: sorgular sırayla (pg aynı istemcide eşzamanlı sorguyu kaldırıyor).
  O = await mkUser("pvoya");
  S = await mkUser("pvselin");
  B = await mkUser("pvbaris");
  wsA = (
    await createWorkspace(app, { userId: O.id, name: SECRETS.workspaceName, slug: `pva-${tag}` })
  ).id;
  wsB = (await createWorkspace(app, { userId: B.id, name: "B İşletme", slug: `pvb-${tag}` })).id;
  await as(O, wsA, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
  propA = await mkProperty(O, wsA, "Defne Villa");
  propB = await mkProperty(B, wsB, "Zeytin Ev");
  await addPhoto(O, wsA, propA, true);
  await addPhoto(O, wsA, propA);
  await addPhoto(B, wsB, propB, true);
  await as(O, wsA, (tx, ctx) => updateWorkspaceWhatsapp(tx, ctx, "0532 123 45 67"));
  await as(B, wsB, (tx, ctx) => updateWorkspaceWhatsapp(tx, ctx, "0555 987 65 43"));
  await publish(O, wsA, propA, slugA);
  await publish(B, wsB, propB, slugB);

  // Fiyatlar: geçmiş (dışarıda kalmalı), bugünü kapsayan, gelecek, ufkun ötesi (dışarıda).
  await rate(wsA, propA, O, d(-60), d(-30), 5000);
  await rate(wsA, propA, O, d(-5), d(30), 6500);
  await rate(wsA, propA, O, d(30), d(90), 8500);
  await rate(wsA, propA, O, addDays(lastCheckInDay(T), 200), addDays(lastCheckInDay(T), 230), 9999);
  await rate(wsB, propB, B, d(0), d(60), 4000);

  // Rezervasyonlar: geçmiş, bitişik ikili (birleşmeli), beklemede, blok, iptal (görünmemeli).
  await res(wsA, propA, O, d(-20), d(-10));
  await res(wsA, propA, O, d(10), d(15));
  await res(wsA, propA, O, d(15), d(18), { status: "pending" });
  await res(wsA, propA, O, d(25), d(27), { kind: "block" });
  await res(wsA, propA, O, d(40), d(45), { status: "pending" });
  await res(wsA, propA, O, d(50), d(55));
  await admin.query(
    "update reservations set status = 'cancelled', cancel_reason = $1 where check_in = $2 and property_id = $3",
    [SECRETS.cancelReason, d(50), propA],
  );
  await res(wsB, propB, B, d(5), d(9));
});

afterAll(async () => {
  await admin.end();
  await appPool.end();
});

describe("public villa verisi", () => {
  it("yalnız izin verilen alanlar; adres, belge no, misafir ve işletme bilgisi yok", async () => {
    const v = await villa(slugA);
    expect(v).not.toBeNull();
    expect(Object.keys(v!).sort()).toEqual([...PUBLIC_VILLA_KEYS].sort());
    expect(v).toMatchObject({
      slug: slugA,
      name: "Defne Villa",
      maxGuests: 8,
      bedrooms: 4,
      location: { province: "Antalya", district: "Kaş", neighborhood: "Kalkan" },
      pools: { swimming: { depth: 1.6, width: 4, length: 9, protected: true }, indoor: null },
      amenities: ["wifi", "otopark"],
      checkInTime: "16:00",
      checkOutTime: "10:00",
      whatsapp: "+905321234567",
      currency: "TRY",
    });
    expect(v!.descriptionHtml).toContain("<strong>400 m</strong>");
    expect(v!.photos).toHaveLength(2);
    expect(v!.photos[0]!.isCover).toBe(true);
    expect(v!.photos[0]!.src).toMatch(/^https:\/\/img\.test\.invalid\/w\/.+\/1200\.webp$/);
    const json = JSON.stringify(v);
    for (const [k, secret] of Object.entries(SECRETS)) expect(json, k).not.toContain(secret);
    expect(json).not.toContain("42424"); // rezervasyon tutarı
    expect(json).not.toContain(`pva-${tag}`); // işletme kısa adresi
    expect(json).not.toMatch(
      /guest_|guestName|guestPhone|guestEmail|address|postal|latitude|longitude|license|workspace|cancel_reason|"note"/i,
    );
  });

  it("dolu tarihler: beklemede + onaylı + blok ayrımsız ve birleşik; iptal ve geçmiş yok", async () => {
    const v = await villa(slugA);
    expect(v!.busy).toEqual([
      { start: d(10), end: d(18) },
      { start: d(25), end: d(27) },
      { start: d(40), end: d(45) },
    ]);
    expect(Object.keys(v!.busy[0]!)).toEqual(["start", "end"]);
  });

  it("fiyatlar: bugünü kapsayan ve gelecek dönemler; geçmiş ve ufkun ötesi yok; kimlik sentetik", async () => {
    const v = await villa(slugA);
    expect(v!.rates.map((r) => [r.id, r.startDate, r.endDate, r.nightlyAmountMinor])).toEqual([
      ["d1", d(-5), d(30), 650000],
      ["d2", d(30), d(90), 850000],
    ]);
    expect(v!.rates[0]).toMatchObject({
      weeklyAmountMinor: 3900000,
      minNights: 3,
      cleaningFeeMinor: 250000,
      cleaningFeeFreeNights: 7,
    });
    expect(v!.window).toEqual({ today: T, lastCheckIn: lastCheckInDay(T), maxNights: 60 });
  });

  it("işletmeler birbirinin verisini görmez", async () => {
    const b = await villa(slugB);
    expect(b!.name).toBe("Zeytin Ev");
    expect(b!.busy).toEqual([{ start: d(5), end: d(9) }]);
    expect(b!.rates).toHaveLength(1);
    expect(JSON.stringify(b)).not.toContain("Defne");
    // A'nın kimliğiyle B'nin verisi, B'nin kimliğiyle A'nınki karışmaz.
    const photosA = await fn<{ storage_prefix: string }>(
      sql`select * from app_public_villa_photos(${propA})`,
    );
    expect(photosA.every((p) => p.storage_prefix.includes(propA))).toBe(true);
  });

  it("adres normalleşir; geçersiz/olmayan adres null", async () => {
    expect((await villa(`  VILLA-A-${tag.toUpperCase()} `))?.name).toBe("Defne Villa");
    expect(await villa("olmayan-villa")).toBeNull();
    expect(await villa("a--b")).toBeNull();
    expect(await villa("'; drop table properties; --")).toBeNull();
    expect(await villa("")).toBeNull();
  });
});

describe("görünürlük: koşullardan biri bozulunca 404 (null) ve tüm fonksiyonlar boş", () => {
  const empty = async (prop: string) => {
    for (const q of [
      sql`select * from app_public_villa_photos(${prop})`,
      sql`select * from app_public_villa_rates(${prop})`,
      sql`select * from app_public_villa_busy(${prop}, ${d(-5)}::date, ${d(300)}::date)`,
    ])
      expect(await fn(q)).toEqual([]);
  };

  it("yayından kaldırma", async () => {
    await admin.query("update properties set is_public = false where id = $1", [propA]);
    expect(await villa(slugA)).toBeNull();
    await empty(propA);
    await admin.query("update properties set is_public = true where id = $1", [propA]);
    expect(await villa(slugA)).not.toBeNull();
  });

  it("pasif mülk", async () => {
    await as(O, wsA, (tx, ctx) => setPropertyStatus(tx, ctx, propA, "passive"));
    expect(await villa(slugA)).toBeNull();
    await empty(propA);
    await as(O, wsA, (tx, ctx) => setPropertyStatus(tx, ctx, propA, "active"));
  });

  it("WhatsApp numarası kaldırılınca", async () => {
    await admin.query("update workspaces set contact_whatsapp = null where id = $1", [wsA]);
    expect(await villa(slugA)).toBeNull();
    await empty(propA);
    await admin.query("update workspaces set contact_whatsapp = '+905321234567' where id = $1", [
      wsA,
    ]);
  });

  it("abonelik sona erince", async () => {
    await admin.query(
      "update workspace_subscriptions set trial_ends_at = now() - interval '1 minute' where workspace_id = $1",
      [wsA],
    );
    expect(await villa(slugA)).toBeNull();
    await empty(propA);
    await admin.query(
      "update workspace_subscriptions set trial_ends_at = now() + interval '14 days' where workspace_id = $1",
      [wsA],
    );
  });

  it("işletme askıya alınınca", async () => {
    await admin.query("update workspaces set status = 'suspended' where id = $1", [wsA]);
    expect(await villa(slugA)).toBeNull();
    await empty(propA);
    await admin.query("update workspaces set status = 'active' where id = $1", [wsA]);
  });

  it("fotoğraf kalmayınca", async () => {
    const saved = (
      await admin.query("select * from property_photos where property_id = $1", [propB])
    ).rows;
    await admin.query("delete from property_photos where property_id = $1", [propB]);
    expect(await villa(slugB)).toBeNull();
    await empty(propB);
    for (const p of saved) {
      await admin.query(
        `insert into property_photos (id, workspace_id, property_id, created_by, storage_prefix, width, height,
           quality, bytes_400, bytes_1200, bytes_2000, sort_order, is_cover, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          p.id,
          p.workspace_id,
          p.property_id,
          p.created_by,
          p.storage_prefix,
          p.width,
          p.height,
          p.quality,
          p.bytes_400,
          p.bytes_1200,
          p.bytes_2000,
          p.sort_order,
          p.is_cover,
          p.created_at,
        ],
      );
    }
    expect(await villa(slugB)).not.toBeNull();
  });

  it("taslak mülkün kimliğiyle doğrudan fonksiyon çağrısı boş döner", async () => {
    const draft = uuidv7();
    await admin.query("begin");
    await admin.query("set local session_replication_role = replica");
    await admin.query(
      `insert into properties (id, workspace_id, name, property_type, max_guests, bedrooms, bathrooms,
         province, district, created_by, public_slug) values ($1,$2,'Taslak','villa',4,2,1,'Antalya','Kaş',$3,$4)`,
      [draft, wsA, O.id, `taslak-${tag}`],
    );
    await admin.query("commit");
    await res(wsA, draft, O, d(3), d(6));
    expect(await villa(`taslak-${tag}`)).toBeNull();
    await empty(draft);
  });
});

describe("veritabanı güvenliği", () => {
  it("fonksiyon yetkileri: PUBLIC kapalı; yalnız 4 okuma fonksiyonu app_user'a; diğer roller yok", async () => {
    const r = await admin.query(`
      select p.proname, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner,
             coalesce((select string_agg(case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end, ',' order by 1)
                         from aclexplode(p.proacl) a where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner), '') as execs,
             array_to_string(p.proconfig, ',') as config
        from pg_proc p where p.proname like 'app_public_villa%' order by p.proname`);
    expect(r.rows).toEqual([
      {
        proname: "app_public_villa",
        definer: true,
        owner: "app_migrator",
        execs: "app_user",
        config: "search_path=pg_catalog, pg_temp",
      },
      {
        proname: "app_public_villa_busy",
        definer: true,
        owner: "app_migrator",
        execs: "app_user",
        config: "search_path=pg_catalog, pg_temp",
      },
      {
        proname: "app_public_villa_photos",
        definer: true,
        owner: "app_migrator",
        execs: "app_user",
        config: "search_path=pg_catalog, pg_temp",
      },
      {
        proname: "app_public_villa_rates",
        definer: true,
        owner: "app_migrator",
        execs: "app_user",
        config: "search_path=pg_catalog, pg_temp",
      },
      {
        proname: "app_public_villa_visible",
        definer: true,
        owner: "app_migrator",
        execs: "",
        config: "search_path=pg_catalog, pg_temp",
      },
    ]);
    const visible = await withPublicRead(app, (tx) =>
      tx.execute(sql`select app_public_villa_visible(${propA})`),
    ).then(
      () => "ok",
      (err: unknown) => pgErrorInfo(err).code,
    );
    expect(visible).toBe("42501");
  });

  it("fonksiyon çıktıları sabit kolon listesi", async () => {
    const r = await admin.query(
      `select proname, pg_get_function_result(oid) as result from pg_proc where proname like 'app_public_villa%' and proname <> 'app_public_villa_visible' order by proname`,
    );
    const cols = Object.fromEntries(
      r.rows.map((x) => [
        x.proname,
        (/^TABLE\((.*)\)$/.exec(x.result)?.[1] ?? "")
          .split(",")
          .map((c: string) => c.trim().split(" ")[0]),
      ]),
    );
    expect(cols.app_public_villa_photos).toEqual(["storage_prefix", "width", "height", "is_cover"]);
    expect(cols.app_public_villa_busy).toEqual(["start_date", "end_date"]);
    expect(cols.app_public_villa_rates).toEqual([
      "start_date",
      "end_date",
      "nightly_amount_minor",
      "weekly_amount_minor",
      "currency",
      "min_nights",
      "cleaning_fee_minor",
      "cleaning_fee_free_nights",
    ]);
    const villaCols: string[] = cols.app_public_villa;
    // Revizyon (0025): yatak kolonları çıktı; harita, 7 mesafe, kurallar ve dahil olanlar eklendi.
    // Revizyon 2 (0026): harita yöntemi + iğne (3) ve 7 mesafe birimi eklendi; iptal ve ödeme
    // koşulları çıktı (43 + 10 − 2).
    expect(villaCols).toHaveLength(51);
    expect(villaCols).toEqual(
      expect.arrayContaining([
        "map_mode",
        "map_embed_url",
        "map_pin_lat",
        "map_pin_lng",
        "distance_market_km",
        "distance_market_unit",
        "distance_health_km",
        "distance_health_unit",
        "house_rule_keys",
        "price_includes",
      ]),
    );
    for (const forbidden of [
      "cancellation_policy",
      "payment_terms",
      "beds_double",
      "beds_single",
      "beds_sofa",
      "workspace_id",
      "address_line",
      "postal_code",
      "latitude",
      "longitude",
      "tourism_license_no",
      "created_by",
      "status",
      "is_public",
      "public_slug",
    ]) {
      expect(villaCols).not.toContain(forbidden);
    }
  });

  it("yeni politikalar yalnız app_migrator ve yalnız SELECT; mevcut politikalar korunur", async () => {
    const r = await admin.query(`
      select c.relname, p.polname, p.polcmd, array_to_string(array(select rolname from pg_roles where oid = any(p.polroles)), ',') as roles
        from pg_policy p join pg_class c on c.oid = p.polrelid
       where c.relname in ('properties', 'workspaces', 'workspace_subscriptions', 'property_photos',
                           'property_rates', 'reservations')
       order by c.relname, p.polname`);
    const list = r.rows.map((x) => `${x.relname}:${x.polname}:${x.polcmd}:${x.roles}`);
    const added = list.filter((x) => x.includes("_public_read"));
    expect(added).toEqual([
      "properties:properties_public_read:r:app_migrator",
      "property_photos:property_photos_public_read:r:app_migrator",
      "property_rates:property_rates_public_read:r:app_migrator",
      "reservations:reservations_public_read:r:app_migrator",
      "workspace_subscriptions:subscriptions_public_read:r:app_migrator",
      "workspaces:workspaces_public_read:r:app_migrator",
    ]);
    // Mevcut politikalar (0006–0018) aynen duruyor.
    expect(list.filter((x) => !x.includes("_public_read"))).toEqual([
      "properties:properties_insert:a:app_user",
      "properties:properties_select:r:app_user",
      "properties:properties_update:w:app_user",
      "property_photos:property_photos_delete:d:app_user",
      "property_photos:property_photos_insert:a:app_user",
      "property_photos:property_photos_select:r:app_user",
      "property_photos:property_photos_update:w:app_user",
      "property_rates:property_rates_delete:d:app_user",
      "property_rates:property_rates_insert:a:app_user",
      "property_rates:property_rates_select:r:app_user",
      "property_rates:property_rates_update:w:app_user",
      "reservations:reservations_insert:a:app_user",
      // 0027 (F3): yalnız talep fonksiyonunun açtığı ayarla, yalnız web/beklemede INSERT.
      "reservations:reservations_public_request:a:app_migrator",
      "reservations:reservations_select:r:app_user",
      "reservations:reservations_update:w:app_user",
      "workspace_subscriptions:subscriptions_migrator_trial_insert:a:app_migrator",
      "workspace_subscriptions:subscriptions_select:r:app_user",
      "workspaces:workspaces_insert:a:app_user",
      "workspaces:workspaces_select:r:app_user",
      "workspaces:workspaces_update:w:app_user",
    ]);
  });

  it("app_migrator ayar kapalıyken hiçbir yeni satır görmez; açıkken yalnız yayındakileri", async () => {
    const mig = new Client({ connectionString: db.migratorUrl });
    await mig.connect();
    try {
      const counts = async () =>
        (
          await mig.query(`select (select count(*) from properties)::int p,
                                  (select count(*) from reservations)::int r,
                                  (select count(*) from property_rates)::int rt,
                                  (select count(*) from workspaces)::int w`)
        ).rows[0];
      expect(await counts()).toEqual({ p: 0, r: 0, rt: 0, w: 0 });
      await mig.query("begin");
      await mig.query("set local app.public_read = 'on'");
      const pub = await mig.query(
        "select id, is_public, status from properties where id = any($1)",
        [[propA, propB]],
      );
      expect(pub.rows.every((x) => x.is_public && x.status === "active")).toBe(true);
      const statuses = await mig.query(
        "select distinct status from reservations where property_id = $1",
        [propA],
      );
      expect(statuses.rows.map((x) => x.status).sort()).toEqual(["confirmed", "pending"]);
      expect(
        (await mig.query("select count(*)::int n from properties where not is_public")).rows[0].n,
      ).toBe(0);
      // Politikalar yalnız SELECT: ayar açıkken bile güncelleme hiçbir satıra ulaşmaz.
      expect((await mig.query("update properties set name = name")).rowCount).toBe(0);
      await mig.query("rollback");
    } finally {
      await mig.end();
    }
  });

  it("app_user ayarı açsa da tablolardan doğrudan hiçbir şey göremez (politikalar app_migrator'a)", async () => {
    const r = await withPublicRead(app, async (tx) => {
      await tx.execute(sql`select set_config('app.public_read', 'on', true)`);
      return (
        await tx.execute<{ p: number; r: number; w: number; f: number }>(sql`
          select (select count(*) from properties)::int p, (select count(*) from reservations)::int r,
                 (select count(*) from workspaces)::int w, (select count(*) from property_photos)::int f`)
      ).rows[0];
    });
    expect(r).toEqual({ p: 0, r: 0, w: 0, f: 0 });
  });

  it("public bağlam salt okunur: yazma reddedilir", async () => {
    const code = await withPublicRead(app, (tx) =>
      tx.execute(sql`update properties set name = name`),
    ).then(
      () => "ok",
      (err: unknown) => pgErrorInfo(err).code,
    );
    expect(code).toBe("25006");
  });

  it("dolu tarih penceresi bugün − 1'den önceye ve ufkun ötesine gitmez; ters aralık boş", async () => {
    const all = await fn<{ start_date: string; end_date: string }>(
      sql`select * from app_public_villa_busy(${propA}, ${"2000-01-01"}::date, ${"2100-01-01"}::date)`,
    );
    expect(all.every((b) => b.start_date >= d(-1))).toBe(true);
    expect(all.find((b) => b.start_date === d(-20))).toBeUndefined();
    expect(
      await fn(sql`select * from app_public_villa_busy(${propA}, ${d(30)}::date, ${d(10)}::date)`),
    ).toEqual([]);
    const clipped = await fn<{ start_date: string; end_date: string }>(
      sql`select * from app_public_villa_busy(${propA}, ${d(12)}::date, ${d(14)}::date)`,
    );
    expect(clipped).toEqual([{ start_date: d(12), end_date: d(14) }]);
  });

  it("personel/oturum bağlamı fark etmez: tenant panel sorguları değişmedi", async () => {
    const n = await as(S, wsA, async (tx) => {
      const r = await tx.execute<{ n: number }>(
        sql`select count(*)::int n from properties where workspace_id <> app_current_workspace_id()`,
      );
      return r.rows[0]!.n;
    });
    expect(n).toBe(0);
  });
});

/**
 * F2a güvenlik denetiminin kalıcı regresyonları: app.public_read bayrağı (GUC) bir istekten
 * diğerine taşınmaz, hata sonrası önceki değerine döner ve yetkisiz roller definer fonksiyonları
 * çağıramaz.
 */
describe("app.public_read bayrağı: havuz, hata ve yetki regresyonları", () => {
  type Probe = {
    pid: number;
    flag: string;
    uid: string;
    ws: string;
    p: number;
    r: number;
    w: number;
  };
  // Tek bağlantılık havuz: her adım aynı backend'e düşer, taşınan durum görünür olur.
  const onePool = new Pool({ connectionString: db.appUrl, max: 1 });
  const one = drizzle(onePool, { schema, casing: DB_CASING });
  const probe = async (): Promise<Probe> =>
    (
      await onePool.query<Probe>(`
        select pg_backend_pid() pid,
               coalesce(current_setting('app.public_read', true), '') flag,
               coalesce(current_setting('app.user_id', true), '') uid,
               coalesce(current_setting('app.workspace_id', true), '') ws,
               (select count(*) from properties)::int p,
               (select count(*) from reservations)::int r,
               (select count(*) from workspaces)::int w`)
    ).rows[0]!;
  const clean = { flag: "", uid: "", ws: "", p: 0, r: 0, w: 0 };
  const code = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (err: unknown) => pgErrorInfo(err).code,
    );
  let pid = 0;

  beforeAll(async () => {
    pid = (await probe()).pid;
  });
  afterAll(async () => {
    await onePool.end();
  });

  it("başarılı public okuma commit'inden sonra aynı bağlantı temiz", async () => {
    const n = await withPublicRead(one, async (tx) => {
      const a = await tx.execute(sql`select * from app_public_villa(${slugA})`);
      const b = await tx.execute(
        sql`select * from app_public_villa_busy(${propA}, ${d(0)}::date, ${d(100)}::date)`,
      );
      // Fonksiyon dönünce aynı transaction'da bile bayrak kapalı ve tablolar boş.
      const inside = await tx.execute<{ f: string; c: number }>(
        sql`select coalesce(current_setting('app.public_read', true), '') f, (select count(*) from properties)::int c`,
      );
      expect(inside.rows[0]).toEqual({ f: "", c: 0 });
      return a.rows.length + b.rows.length;
    });
    expect(n).toBeGreaterThan(1);
    expect(await probe()).toEqual({ pid, ...clean });
  });

  it("public okuma içinde hata + elle açılmış bayrak: rollback sonrası temiz", async () => {
    const c = await code(
      withPublicRead(one, async (tx) => {
        await tx.execute(sql`select * from app_public_villa_photos(${propA})`);
        await tx.execute(sql`select set_config('app.public_read', 'on', true)`);
        await tx.execute(sql`select 1 / 0`);
      }),
    );
    expect(c).toBe("22012");
    expect(await probe()).toEqual({ pid, ...clean });
  });

  it("tenant transaction'ında bayrak açılıp commit edilse de sonraki istek temiz", async () => {
    const seen = await withTenant(one, { userId: B.id, workspaceId: wsB }, async (tx) => {
      await tx.execute(sql`select set_config('app.public_read', 'on', true)`);
      return (
        await tx.execute<{ own: number; other: number; a: number }>(sql`
          select (select count(*) from properties where workspace_id = ${wsB})::int own,
                 (select count(*) from properties where workspace_id <> ${wsB})::int other,
                 (select count(*) from reservations where property_id = ${propA})::int a`)
      ).rows[0];
    });
    // Bayrak app_user'a ek satır açmaz: yalnız kendi işletmesi, A'nın yayındaki villası bile yok.
    expect(seen).toEqual({ own: 1, other: 0, a: 0 });
    expect(await probe()).toEqual({ pid, ...clean });
  });

  it("transaction dışı (autocommit) fonksiyon çağrısından sonra temiz", async () => {
    const r = await onePool.query("select * from app_public_villa_rates($1)", [propA]);
    expect(r.rowCount).toBeGreaterThan(0);
    expect(await probe()).toEqual({ pid, ...clean });
  });

  it("başarılı çağrı önceki değeri korur: ayarsız / off / on", async () => {
    const after = async (prev: string | null) => {
      const c = await onePool.connect();
      try {
        await c.query("begin");
        if (prev !== null) await c.query("select set_config('app.public_read', $1, true)", [prev]);
        await c.query("select * from app_public_villa_photos($1)", [propA]);
        const v = (await c.query("select current_setting('app.public_read', true) v")).rows[0].v;
        await c.query("rollback");
        return v as string | null;
      } finally {
        c.release();
      }
    };
    expect(await after(null)).toBe("");
    expect(await after("off")).toBe("off");
    expect(await after("on")).toBe("on");
  });

  it("fonksiyon hata verince bayrak önceki değerine döner (kilit ve süre aşımı)", async () => {
    const blocker = new Client({ connectionString: db.adminUrl });
    await blocker.connect();
    const c = await onePool.connect();
    try {
      await blocker.query("begin");
      await blocker.query(
        "lock table properties, property_photos, property_rates, reservations in access exclusive mode",
      );
      const failing = async (prev: string, timeout: string, q: string, args: unknown[]) => {
        await c.query("begin");
        await c.query("select set_config('app.public_read', $1, true)", [prev]);
        await c.query("savepoint s");
        await c.query(`set local ${timeout} = '200ms'`);
        const err = await c.query(q, args).then(
          () => "ok",
          (e: unknown) => pgErrorInfo(e).code,
        );
        await c.query("rollback to savepoint s");
        const v = (await c.query("select current_setting('app.public_read', true) v")).rows[0].v;
        await c.query("rollback");
        return [err, v];
      };
      // lock_not_available: plpgsql EXCEPTION WHEN OTHERS yakalar, geri yükler, yeniden fırlatır.
      expect(
        await failing("off", "lock_timeout", "select * from app_public_villa_photos($1)", [propA]),
      ).toEqual(["55P03", "off"]);
      expect(
        await failing("off", "lock_timeout", "select * from app_public_villa_busy($1, $2, $3)", [
          propA,
          d(0),
          d(30),
        ]),
      ).toEqual(["55P03", "off"]);
      // query_canceled: WHEN OTHERS yakalamaz; alt transaction geri alınırken ayar da geri alınır.
      expect(
        await failing("", "statement_timeout", "select * from app_public_villa_rates($1)", [propA]),
      ).toEqual(["57014", ""]);
      expect(
        await failing("", "lock_timeout", "select * from app_public_villa($1)", [slugA]),
      ).toEqual(["55P03", ""]);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      await blocker.end();
      c.release();
    }
    expect(await probe()).toEqual({ pid, ...clean });
  });

  it("oturum düzeyinde SET bağlantıda kalsa da app_user hiçbir satır görmez; public okuma aynı", async () => {
    const before = await withPublicRead(
      one,
      async (tx) =>
        (await tx.execute(sql`select * from app_public_villa_photos(${propA})`)).rows.length,
    );
    await onePool.query("set app.public_read = 'on'");
    try {
      const p = await probe();
      expect(p).toEqual({ pid, ...clean, flag: "on" });
      const during = await withPublicRead(
        one,
        async (tx) =>
          (await tx.execute(sql`select * from app_public_villa_photos(${propA})`)).rows.length,
      );
      expect(during).toBe(before);
    } finally {
      await onePool.query("reset app.public_read");
    }
    expect((await probe()).flag).toBe("");
  });

  it("yetkisiz roller app_migrator'ın definer fonksiyonlarını çağıramaz", async () => {
    const defs = (
      await admin.query<{ sig: string; name: string; args: string }>(`
        select p.oid::regprocedure::text sig, p.proname name, pg_get_function_identity_arguments(p.oid) args
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prosecdef
           and pg_get_userbyid(p.proowner) = 'app_migrator'
         order by 1`)
    ).rows;
    expect(defs.map((x) => x.name).sort()).toEqual([
      "app_current_membership_role",
      "app_current_workspace_unclaimed",
      "app_public_reservation_request",
      "app_public_villa",
      "app_public_villa_busy",
      "app_public_villa_photos",
      "app_public_villa_rates",
      "app_public_villa_visible",
      "app_workspace_members_keep_owner",
      "app_workspace_start_trial",
    ]);
    const call = (x: { name: string; args: string }) => {
      const args: Record<string, string> = {
        "": "",
        "p_slug text": `'${slugA}'`,
        "p_property uuid": `'${propA}'::uuid`,
        "p_property uuid, p_from date, p_to date": `'${propA}'::uuid, current_date, current_date + 5`,
        "p_id uuid, p_slug text, p_check_in date, p_check_out date, p_guests integer, p_name text, p_phone text, p_email text, p_note text, p_total_minor bigint, p_currency text": `gen_random_uuid(), '${slugA}', current_date + 400, current_date + 403, 1, 'Yetkisiz', '+905320000000', null, null, null, null`,
      };
      expect(x.args in args, x.args).toBe(true);
      return `select public.${x.name}(${args[x.args]})`;
    };
    const tryAs = async (role: string, q: string) => {
      await admin.query("savepoint t");
      await admin.query(`set local role ${role}`);
      const c = await admin.query(q).then(
        () => "ok",
        (e: unknown) => pgErrorInfo(e).code,
      );
      await admin.query("rollback to savepoint t");
      return c;
    };
    const nobody = `pv_nobody_${tag}`;
    await admin.query("begin");
    try {
      // Rol ve şema yetkisi transaction'la birlikte geri alınır; yalnız fonksiyon yetkisi sınanır.
      await admin.query(`create role ${nobody} nologin`);
      await admin.query(`grant usage on schema public to ${nobody}`);
      for (const x of defs)
        expect([x.name, await tryAs(nobody, call(x))]).toEqual([x.name, "42501"]);
      for (const name of [
        "app_public_villa_visible",
        "app_workspace_members_keep_owner",
        "app_workspace_start_trial",
      ]) {
        const x = defs.find((y) => y.name === name)!;
        expect([name, await tryAs("app_user", call(x))]).toEqual([name, "42501"]);
      }
    } finally {
      await admin.query("rollback");
    }
    expect(
      (await admin.query("select count(*)::int n from pg_roles where rolname = $1", [nobody]))
        .rows[0].n,
    ).toBe(0);
  });
});
