import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { EMPTY_PROPERTY_VALUES, wizardFormValues } from "@/lib/property-wizard";
import { plainTextToHtml } from "@/lib/rich-text";
import { photoPrefix } from "@/server/properties/photos";
import {
  propertyToRaw,
  saveWizardStep,
  stayToRaw,
  updateStayFields,
} from "@/server/properties/property-fields";
import {
  getPublicProfile,
  publishProperty,
  updatePublicProfile,
  updatePublicSlug,
} from "@/server/properties/public-profile";
import { createProperty, getProperty } from "@/server/properties/service";
import { getPublicVilla } from "@/server/public/villa";
import { createMemoryStorage } from "@/server/storage/memory";
import { updateWorkspaceWhatsapp } from "@/server/workspaces/contact";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

/**
 * Panel yeniden tasarımı – Aşama 3: beş adımlı sihirbazın kayıt servisi (gerçek PostgreSQL,
 * app_user). `saveWizardStep` server action'ın çağırdığı fonksiyonun aynısıdır; FormData da
 * action'daki gibi `wizardFormValues` ile çözülür. Her adım yalnız kendi alanlarını değiştirir.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 6 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");

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
const row = async (id: string) =>
  (
    await admin.query(
      `select name, property_type, province, district, neighborhood, max_guests, bedrooms, bathrooms,
              map_mode, map_embed_url, map_pin_lat::text, map_pin_lng::text,
              distance_market_km::text, distance_market_unit, distance_beach_km::text,
              distance_beach_unit,
              distance_airport_dlm_km::text, tourism_license_no, description, description_html,
              youtube_video_ids, house_rule_keys, price_includes,
              pool_swimming, pool_swimming_depth::text, pool_swimming_width::text,
              pool_swimming_length::text, pool_swimming_protected, pool_indoor, pool_kids,
              public_slug, is_public, public_published_at, amenities, check_in_time::text,
              check_out_time::text, house_rules, cancellation_policy, payment_terms, status
         from properties where id = $1`,
      [id],
    )
  ).rows[0] as Record<string, unknown>;
const audits = async (ws: string, action: string) =>
  (
    await admin.query(
      "select metadata from audit_log where workspace_id = $1 and action = $2 order by occurred_at, id",
      [ws, action],
    )
  ).rows.map((r) => r.metadata);
const form = (entries: [string, string][]) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code?: string; fieldErrors?: Record<string, string[]> }) => e,
  );
/** İki satır arasında değişen kolonlar. */
const diff = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  Object.keys(a)
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .sort();

const BASICS: [string, string][] = [
  ["name", "Defne Villa"],
  ["propertyType", "villa"],
  ["province", "Antalya"],
  ["district", "Kaş"],
  ["neighborhood", "Kalkan"],
  ["maxGuests", "8"],
  ["bedrooms", "4"],
  ["bathrooms", "3"],
  [
    "mapLocation",
    '<iframe src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3196.1!2d29.414301!3d36.265512!2m3!1f0!2f0!3f0" width="600" height="450"></iframe>',
  ],
  ["distanceMarketKm", "0,4"],
  ["distanceBeachKm", "1,2"],
  ["distanceAirportDlmKm", "112"],
  ["tourismLicenseNo", "07-1234"],
];

let O: U, M: U, S: U, X: U;
let ws: string, wsX: string, prop: string;

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("a3owner");
  M = await mkUser("a3manager");
  S = await mkUser("a3staff");
  X = await mkUser("a3other");
  ws = (await createWorkspace(app, { userId: O.id, name: "A3 İşletme", slug: `a3-${tag}` })).id;
  wsX = (await createWorkspace(app, { userId: X.id, name: "A3 Diğer", slug: `a3x-${tag}` })).id;
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
});

afterAll(async () => {
  await admin.end();
  await appPool.end();
});

describe("1. adım ile yeni mülk", () => {
  it("yalnız temel bilgilerle oluşur; diğer adımların alanları başlangıç değerinde", async () => {
    const values = wizardFormValues("temel", form(BASICS));
    prop = await as(O, ws, (tx, ctx) =>
      createProperty(tx, ctx, { ...EMPTY_PROPERTY_VALUES, ...values }),
    );
    expect(await row(prop)).toMatchObject({
      name: "Defne Villa",
      neighborhood: "Kalkan",
      max_guests: 8,
      map_embed_url:
        "https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3196.1!2d29.414301!3d36.265512!2m3!1f0!2f0!3f0",
      map_mode: "google",
      map_pin_lat: null,
      distance_market_km: "0.400",
      distance_market_unit: "km",
      distance_beach_km: "1.200",
      distance_airport_dlm_km: "112.000",
      tourism_license_no: "07-1234",
      house_rule_keys: [],
      price_includes: [],
      description: null,
      description_html: null,
      youtube_video_ids: [],
      pool_swimming: false,
      amenities: [],
      house_rules: null,
      public_slug: null,
      is_public: false,
      status: "active",
    });
  });
});

describe("her adım yalnız kendi alanlarını kaydeder", () => {
  it("2. adım: açıklama ve tek video; başka hiçbir alan değişmez", async () => {
    const before = await row(prop);
    const values = wizardFormValues(
      "aciklama",
      form([
        ["description", "<p>Denize <strong>400 m</strong>.</p>"],
        ["youtubeUrl", "https://youtu.be/aBcDeFgHiJ0"],
        // Başka adımın alanı formda olsa bile okunmaz.
        ["name", "Sızan Ad"],
      ]),
    );
    const r = await as(M, ws, (tx, ctx) => saveWizardStep(tx, ctx, prop, "aciklama", values));
    expect(r.changed).toBe(2);
    const after = await row(prop);
    expect(diff(before, after)).toEqual(["description", "description_html", "youtube_video_ids"]);
    expect(after.name).toBe("Defne Villa");
  });

  it("3. adım: olanaklar ve havuz birlikte; temel, açıklama ve konaklama bilgileri korunur", async () => {
    await as(O, ws, (tx, ctx) =>
      saveWizardStep(tx, ctx, prop, "konaklama", {
        checkInTime: "16:00",
        checkOutTime: "10:00",
        houseRules: "Sessiz saatler 23:00 sonrası.",
        cancellationPolicy: "30 gün önce ücretsiz.",
        paymentTerms: "%30 ön ödeme.",
      }),
    );
    const before = await row(prop);
    const values = wizardFormValues(
      "olanaklar",
      form([
        ["amenities", "wifi"],
        ["amenities", "otopark"],
        ["poolSwimming", "yes"],
        ["poolSwimmingDepth", "1,55"],
        ["poolSwimmingWidth", "4"],
        ["poolSwimmingLength", "9,25"],
        ["poolSwimmingProtected", "yes"],
        ["poolIndoor", "no"],
        ["poolKids", "no"],
      ]),
    );
    const r = await as(O, ws, (tx, ctx) => saveWizardStep(tx, ctx, prop, "olanaklar", values));
    const after = await row(prop);
    expect(diff(before, after)).toEqual([
      "amenities",
      "pool_swimming",
      "pool_swimming_depth",
      "pool_swimming_length",
      "pool_swimming_protected",
      "pool_swimming_width",
    ]);
    expect(r.changed).toBe(2); // havuzlar (tek denetim alanı) + olanaklar
    expect(after).toMatchObject({
      amenities: ["wifi", "otopark"],
      pool_swimming_depth: "1.55",
      house_rules: "Sessiz saatler 23:00 sonrası.",
    });
    // Denetim kayıtları ayrı ayrı: havuz alanları mülk güncellemesinde, olanaklar sayfa
    // ayarlarında; değerler yazılmaz, yalnız alan adları.
    expect((await audits(ws, "property.public_profile_updated")).at(-1)).toEqual({
      fields: ["amenities"],
    });
    expect((await audits(ws, "property.updated")).at(-1)).toEqual({ fields: ["pools"] });
  });

  it("3. adım: hiçbir olanak seçilmezse yalnız olanaklar boşalır", async () => {
    const before = await row(prop);
    const values = wizardFormValues(
      "olanaklar",
      form([
        ["poolSwimming", "yes"],
        ["poolSwimmingDepth", "1,55"],
        ["poolSwimmingWidth", "4"],
        ["poolSwimmingLength", "9,25"],
        ["poolSwimmingProtected", "yes"],
        ["poolIndoor", "no"],
        ["poolKids", "no"],
      ]),
    );
    await as(O, ws, (tx, ctx) => saveWizardStep(tx, ctx, prop, "olanaklar", values));
    const after = await row(prop);
    expect(diff(before, after)).toEqual(["amenities"]);
    expect(after.amenities).toEqual([]);
    await as(O, ws, (tx, ctx) =>
      saveWizardStep(tx, ctx, prop, "olanaklar", { ...values, amenities: ["wifi", "otopark"] }),
    );
  });

  it("4. adım: yalnız saatler ve metinler; olanaklar, havuz ve sayfa adresi korunur", async () => {
    await as(O, ws, (tx, ctx) =>
      updatePublicSlug(tx, ctx, prop, { publicSlug: `a3-villa-${tag}`, confirmSlugChange: false }),
    );
    const before = await row(prop);
    const values = wizardFormValues(
      "konaklama",
      form([
        ["checkInTime", "15:00"],
        ["checkOutTime", "10:00"],
        ["houseRules", "Sessiz saatler 23:00 sonrası."],
        // Revizyon 2: kaldırılan alanlar; gönderilse de okunmaz/yazılmaz.
        ["cancellationPolicy", "Sızan iptal metni"],
        ["paymentTerms", "%30 ön ödeme."],
        ["amenities", "jakuzi"], // başka adımın alanı: okunmaz
      ]),
    );
    expect(values).not.toHaveProperty("cancellationPolicy");
    const r = await as(O, ws, (tx, ctx) => saveWizardStep(tx, ctx, prop, "konaklama", values));
    expect(r.changed).toBe(1);
    const after = await row(prop);
    expect(diff(before, after)).toEqual(["check_in_time"]);
    expect(after).toMatchObject({
      check_in_time: "15:00:00",
      cancellation_policy: null,
      payment_terms: null,
      amenities: ["wifi", "otopark"],
      public_slug: `a3-villa-${tag}`,
    });
  });

  it("1. adım: temel bilgiler; açıklama, havuz ve konaklama bilgileri korunur", async () => {
    const before = await row(prop);
    const values = wizardFormValues(
      "temel",
      form(
        BASICS.map(([k, v]) => [k, k === "maxGuests" ? "10" : k === "distanceMarketKm" ? "" : v]),
      ),
    );
    const r = await as(M, ws, (tx, ctx) => saveWizardStep(tx, ctx, prop, "temel", values));
    expect(r.changed).toBe(2); // kapasite + mesafeler (tek denetim alanı)
    // Mesafe boşaltılınca birimi de kalkar.
    expect(diff(before, await row(prop))).toEqual([
      "distance_market_km",
      "distance_market_unit",
      "max_guests",
    ]);
    expect((await audits(ws, "property.updated")).at(-1)).toEqual({
      fields: ["max_guests", "distances"],
    });
  });

  it("değişiklik yoksa hiçbir şey yazılmaz", async () => {
    const before = await row(prop);
    const nU = (await audits(ws, "property.updated")).length;
    const nP = (await audits(ws, "property.public_profile_updated")).length;
    const values = wizardFormValues(
      "olanaklar",
      form([
        ["amenities", "otopark"],
        ["amenities", "wifi"],
        ["poolSwimming", "yes"],
        ["poolSwimmingDepth", "1,55"],
        ["poolSwimmingWidth", "4,00"],
        ["poolSwimmingLength", "9,25"],
        ["poolSwimmingProtected", "yes"],
        ["poolIndoor", "no"],
        ["poolKids", "no"],
      ]),
    );
    const r = await as(O, ws, (tx, ctx) => saveWizardStep(tx, ctx, prop, "olanaklar", values));
    expect(r.changed).toBe(0);
    expect(await row(prop)).toEqual(before);
    expect((await audits(ws, "property.updated")).length).toBe(nU);
    expect((await audits(ws, "property.public_profile_updated")).length).toBe(nP);
  });
});

describe("revizyon: kurallar, fiyata dahil olanlar, harita, eski veriler", () => {
  it("4. adım: hazır kurallar + ek not + fiyata dahil olanlar kaydedilir ve geri okunur", async () => {
    const before = await row(prop);
    const values = wizardFormValues(
      "konaklama",
      form([
        ["checkInTime", "15:00"],
        ["checkOutTime", "10:00"],
        ["houseRuleKeys", "parti-yok"],
        ["houseRuleKeys", "sigara-icilmez"],
        ["houseRuleKeys", "sigara-icilmez"],
        ["houseRules", "Sessiz saatler 23:00 sonrası."],
        ["priceIncludes", "su"],
        ["priceIncludes", "elektrik"],
        ["paymentTerms", "%30 ön ödeme."],
      ]),
    );
    const r = await as(O, ws, (tx, ctx) => saveWizardStep(tx, ctx, prop, "konaklama", values));
    expect(r.changed).toBe(2);
    const after = await row(prop);
    expect(diff(before, after)).toEqual(["house_rule_keys", "price_includes"]);
    // Tekrarsız, katalog sırasıyla.
    expect(after).toMatchObject({
      house_rule_keys: ["sigara-icilmez", "parti-yok"],
      price_includes: ["elektrik", "su"],
    });
    expect((await audits(ws, "property.public_profile_updated")).at(-1)).toEqual({
      fields: ["house_rule_keys", "price_includes"],
    });
    const p = await as(S, ws, (tx) => getPublicProfile(tx, prop));
    expect(p).toMatchObject({
      houseRuleKeys: ["sigara-icilmez", "parti-yok"],
      priceIncludes: ["elektrik", "su"],
    });
  });

  it("katalog dışı seçim reddedilir; olanaklar adımı kuralları değiştirmez; eski birleşik kayıt da", async () => {
    const before = await row(prop);
    const e = await failure(
      as(O, ws, (tx, ctx) =>
        saveWizardStep(tx, ctx, prop, "konaklama", { houseRuleKeys: ["yok-boyle-kural"] }),
      ),
    );
    expect(Object.keys(e?.fieldErrors ?? {})).toEqual(["houseRuleKeys"]);
    await as(O, ws, (tx, ctx) =>
      saveWizardStep(tx, ctx, prop, "olanaklar", {
        amenities: ["wifi", "otopark", "klima"],
        poolSwimming: "yes",
        poolSwimmingDepth: "1,55",
        poolSwimmingWidth: "4",
        poolSwimmingLength: "9,25",
        poolSwimmingProtected: "yes",
        poolIndoor: "no",
        poolKids: "no",
      }),
    );
    await as(O, ws, (tx, ctx) =>
      updatePublicProfile(tx, ctx, prop, {
        publicSlug: `a3-villa-${tag}`,
        amenities: ["wifi", "otopark", "klima"],
        checkInTime: "15:00",
        checkOutTime: "10:00",
        houseRules: "Sessiz saatler 23:00 sonrası.",
        paymentTerms: "%30 ön ödeme.",
      }),
    );
    expect(await row(prop)).toMatchObject({
      amenities: ["klima", "wifi", "otopark"], // katalog sırası (Revizyon 2 kategorileri)
      house_rule_keys: before.house_rule_keys,
      price_includes: before.price_includes,
    });
  });

  it("'Evcil hayvan kabul edilmez' kuralı ile 'Evcil hayvan kabul edilir' olanağı birlikte seçilemez", async () => {
    const pools = {
      poolSwimming: "yes",
      poolSwimmingDepth: "1,55",
      poolSwimmingWidth: "4",
      poolSwimmingLength: "9,25",
      poolSwimmingProtected: "yes",
      poolIndoor: "no",
      poolKids: "no",
    };
    // Önce olanak seçili: kural eklenemez.
    await as(O, ws, (tx, ctx) =>
      saveWizardStep(tx, ctx, prop, "olanaklar", { ...pools, amenities: ["wifi", "evcil-hayvan"] }),
    );
    let before = await row(prop);
    let e = await failure(
      as(O, ws, (tx, ctx) =>
        saveWizardStep(tx, ctx, prop, "konaklama", { houseRuleKeys: ["evcil-hayvan-yok"] }),
      ),
    );
    expect(e?.code).toBe("VALIDATION");
    expect(e?.fieldErrors?.houseRuleKeys?.[0]).toMatch(/çelişiyor/);
    expect(await row(prop)).toEqual(before);
    // Ters yön: kural seçiliyken olanak eklenemez.
    await as(O, ws, (tx, ctx) =>
      saveWizardStep(tx, ctx, prop, "olanaklar", { ...pools, amenities: ["wifi", "otopark"] }),
    );
    await as(O, ws, (tx, ctx) =>
      saveWizardStep(tx, ctx, prop, "konaklama", { houseRuleKeys: ["evcil-hayvan-yok"] }),
    );
    before = await row(prop);
    e = await failure(
      as(O, ws, (tx, ctx) =>
        saveWizardStep(tx, ctx, prop, "olanaklar", { ...pools, amenities: ["evcil-hayvan"] }),
      ),
    );
    expect(e?.fieldErrors?.amenities?.[0]).toMatch(/çelişiyor/);
    expect(await row(prop)).toEqual(before);
    await as(O, ws, (tx, ctx) =>
      saveWizardStep(tx, ctx, prop, "konaklama", {
        houseRuleKeys: ["sigara-icilmez", "parti-yok"],
      }),
    );
  });

  it("harita: alan boşaltılınca kaldırılır; misafir sayfası verisinde gösterilmez", async () => {
    await as(O, ws, (tx, ctx) =>
      saveWizardStep(tx, ctx, prop, "temel", { ...Object.fromEntries(BASICS), mapLocation: "" }),
    );
    expect((await row(prop)).map_embed_url).toBeNull();
    await as(O, ws, (tx, ctx) =>
      saveWizardStep(tx, ctx, prop, "temel", Object.fromEntries(BASICS)),
    );
    expect((await row(prop)).map_embed_url).toMatch(
      /^https:\/\/www\.google\.com\/maps\/embed\?pb=/,
    );
  });

  it("1. aşama: eski kolonlar (yatak, açık adres, posta kodu, koordinat) okunmaz/yazılmaz, değerleri korunur", async () => {
    await admin.query(
      `update properties set beds_double = 3, beds_single = 2, beds_sofa = 1,
              address_line = 'Gizli adres 1', postal_code = '07960',
              latitude = 36.111111, longitude = 29.222222 where id = $1`,
      [prop],
    );
    const legacy = async () =>
      (
        await admin.query(
          `select beds_double, beds_single, beds_sofa, address_line, postal_code,
                  latitude::text, longitude::text from properties where id = $1`,
          [prop],
        )
      ).rows[0];
    const before = await legacy();
    for (const step of ["temel", "aciklama", "olanaklar", "konaklama"] as const) {
      const p = (await as(O, ws, (tx) => getProperty(tx, prop)))!;
      const raw = {
        ...propertyToRaw(p),
        ...stayToRaw((await as(O, ws, (tx) => getPublicProfile(tx, prop)))!),
      };
      await as(O, ws, (tx, ctx) =>
        saveWizardStep(tx, ctx, prop, step, {
          ...raw,
          // Kötü niyetli istemci eski alanları gönderse de yazılmaz.
          bedsDouble: "9",
          addressLine: "Sızan",
          latitude: "1",
          longitude: "1",
          maxGuests: step === "temel" ? "7" : raw.maxGuests,
        }),
      );
    }
    expect(await legacy()).toEqual(before);
    expect(before).toMatchObject({ beds_double: 3, address_line: "Gizli adres 1" });
    // Uygulama nesnesinde eski alanlar yok.
    const p = (await as(O, ws, (tx) => getProperty(tx, prop)))!;
    for (const k of ["bedsDouble", "addressLine", "postalCode", "latitude", "longitude"]) {
      expect(p, k).not.toHaveProperty(k);
    }
  });
});

describe("hata ve yetki", () => {
  it("bir alan geçersizse adımın hiçbir alanı kaydedilmez (havuz hatası → olanaklar da yazılmaz)", async () => {
    const before = await row(prop);
    const e = await failure(
      as(O, ws, (tx, ctx) =>
        saveWizardStep(tx, ctx, prop, "olanaklar", {
          amenities: ["wifi", "otopark", "jakuzi"],
          poolSwimming: "yes",
          poolSwimmingDepth: "",
          poolSwimmingWidth: "4",
          poolSwimmingLength: "9,25",
          poolSwimmingProtected: "yes",
          poolIndoor: "no",
          poolKids: "no",
        }),
      ),
    );
    expect(e?.code).toBe("VALIDATION");
    expect(Object.keys(e?.fieldErrors ?? {})).toEqual(["poolSwimmingDepth"]);
    expect(await row(prop)).toEqual(before);

    const e2 = await failure(
      as(O, ws, (tx, ctx) =>
        saveWizardStep(tx, ctx, prop, "konaklama", { checkInTime: "7:00", houseRules: "Yeni" }),
      ),
    );
    expect(Object.keys(e2?.fieldErrors ?? {})).toEqual(["checkInTime"]);
    expect(await row(prop)).toEqual(before);
  });

  it("staff hiçbir adımı kaydedemez; başka işletme mülkü göremez", async () => {
    const before = await row(prop);
    for (const step of ["temel", "aciklama", "olanaklar", "konaklama"] as const) {
      const e = await failure(
        as(S, ws, (tx, ctx) => saveWizardStep(tx, ctx, prop, step, { name: "Staff" })),
      );
      expect(e?.code, step).toBe("FORBIDDEN");
    }
    expect(
      (await failure(as(S, ws, (tx, ctx) => updateStayFields(tx, ctx, prop, { houseRules: "S" }))))
        ?.code,
    ).toBe("FORBIDDEN");
    const other = await failure(
      as(X, wsX, (tx, ctx) => saveWizardStep(tx, ctx, prop, "konaklama", { houseRules: "X" })),
    );
    expect(other?.code).toBe("NOT_FOUND");
    expect(
      (await failure(as(O, ws, (tx, ctx) => saveWizardStep(tx, ctx, "yok", "temel", {}))))?.code,
    ).toBe("NOT_FOUND");
    expect(await row(prop)).toEqual(before);
  });

  it("yayındaki mülkte olanak/konaklama kaydı adres onayı istemez ve yayını bozmaz", async () => {
    const photo = uuidv7();
    await admin.query(
      `insert into property_photos (id, workspace_id, property_id, created_by, storage_prefix, width, height,
         quality, bytes_400, bytes_1200, bytes_2000, is_cover)
       values ($1,$2,$3,$4,$5,1800,1200,82,1,1,1,true)`,
      [photo, ws, prop, O.id, photoPrefix(ws, prop, photo)],
    );
    await as(O, ws, (tx, ctx) => updateWorkspaceWhatsapp(tx, ctx, "0532 111 22 33"));
    await as(O, ws, (tx, ctx) => publishProperty(tx, ctx, prop));
    await as(M, ws, (tx, ctx) =>
      saveWizardStep(tx, ctx, prop, "konaklama", { houseRules: "14 gün önce haber verin." }),
    );
    await as(M, ws, (tx, ctx) =>
      saveWizardStep(tx, ctx, prop, "temel", Object.fromEntries(BASICS)),
    );
    expect(await row(prop)).toMatchObject({
      is_public: true,
      public_slug: `a3-villa-${tag}`,
      house_rules: "14 gün önce haber verin.",
      max_guests: 8,
    });
  });
});

describe("eski açıklama biçimi", () => {
  it("düz metin açıklama 1., 3. ve 4. adım kaydında kaybolmaz; 2. adımda HTML olarak gelir", async () => {
    const legacy = "Bahçeli taş ev.\nDenize 5 dakika.\n\nEski <kayıt> & not.";
    await admin.query(
      "update properties set description = $1, description_html = null where id = $2",
      [legacy, prop],
    );
    await as(O, ws, (tx, ctx) =>
      saveWizardStep(tx, ctx, prop, "temel", {
        ...Object.fromEntries(BASICS),
        bathrooms: "4",
      }),
    );
    await as(O, ws, (tx, ctx) =>
      saveWizardStep(tx, ctx, prop, "konaklama", { houseRules: "Eski açıklama testi." }),
    );
    await as(O, ws, (tx, ctx) =>
      saveWizardStep(tx, ctx, prop, "olanaklar", {
        amenities: ["wifi"],
        poolSwimming: "yes",
        poolSwimmingDepth: "1,55",
        poolSwimmingWidth: "4",
        poolSwimmingLength: "9,25",
        poolSwimmingProtected: "yes",
        poolIndoor: "no",
        poolKids: "no",
      }),
    );
    const after = await row(prop);
    expect(after.description_html).toBe(plainTextToHtml(legacy));
    expect(after.description).toContain("Bahçeli taş ev.");
    expect(after.description).toContain("Eski <kayıt> & not.");
    expect(after).toMatchObject({ bathrooms: 4, house_rules: "Eski açıklama testi." });
    expect((await audits(ws, "property.updated")).at(-1)).toEqual({ fields: ["bathrooms"] });
  });
});

describe("Revizyon 2: harita yöntemi, mesafe birimleri, kaldırılan alanlar ve eski kayıtlar", () => {
  const storage = createMemoryStorage("https://img.test.invalid");
  const GOOGLE =
    "https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3196.1!2d29.414301!3d36.265512!2m3!1f0!2f0!3f0";
  let p2: string;
  let O2: U, S2: U, ws2: string;
  const slug = () => `rev2-${tag}`;
  const villa = () => getPublicVilla(app, storage, slug());
  const basics = (over: Record<string, string> = {}) => ({
    ...Object.fromEntries(BASICS),
    name: "Rev2 Villa",
    ...over,
  });
  const r2 = async () =>
    (
      await admin.query(
        `select map_mode, map_embed_url, map_pin_lat::text, map_pin_lng::text,
                distance_market_km::text, distance_market_unit, distance_beach_km::text,
                distance_beach_unit, distance_center_km::text, distance_center_unit,
                distance_health_km::text, distance_health_unit,
                house_rule_keys, price_includes, cancellation_policy, payment_terms
           from properties where id = $1`,
        [p2],
      )
    ).rows[0] as Record<string, unknown>;

  beforeAll(async () => {
    // Ayrı işletme: deneme paketinin mülk sınırı ilk işletmede dolu.
    O2 = await mkUser("rev2owner");
    S2 = await mkUser("rev2staff");
    ws2 = (await createWorkspace(app, { userId: O2.id, name: "Rev2 İşletme", slug: `rev2-${tag}` }))
      .id;
    await as(O2, ws2, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S2.id, role: "staff" }));
    await as(O2, ws2, (tx, ctx) => updateWorkspaceWhatsapp(tx, ctx, "0532 111 22 44"));
    p2 = await as(O2, ws2, (tx, ctx) =>
      createProperty(tx, ctx, { ...EMPTY_PROPERTY_VALUES, ...basics({ name: "Rev2 Villa" }) }),
    );
    const photo = uuidv7();
    await admin.query(
      `insert into property_photos (id, workspace_id, property_id, created_by, storage_prefix, width, height,
         quality, bytes_400, bytes_1200, bytes_2000, is_cover)
       values ($1,$2,$3,$4,$5,1800,1200,82,1,1,1,true)`,
      [photo, ws2, p2, O2.id, photoPrefix(ws2, p2, photo)],
    );
    await as(O2, ws2, (tx, ctx) =>
      updatePublicSlug(tx, ctx, p2, { publicSlug: slug(), confirmSlugChange: false }),
    );
    await as(O2, ws2, (tx, ctx) => publishProperty(tx, ctx, p2));
  });

  it("harita: Google → iğne → Google; iki yöntemin verisi korunur, misafire seçili olan gider", async () => {
    expect(await r2()).toMatchObject({ map_mode: "google", map_embed_url: GOOGLE });
    expect((await villa())?.map).toMatchObject({ kind: "google", embedUrl: GOOGLE });

    // İğne yöntemi seçilir, iğne bırakılır (Google kodu formda kalır).
    await as(O2, ws2, (tx, ctx) =>
      saveWizardStep(
        tx,
        ctx,
        p2,
        "temel",
        basics({ mapMode: "pin", mapPinLat: "36.2655", mapPinLng: "29.414712" }),
      ),
    );
    expect(await r2()).toMatchObject({
      map_mode: "pin",
      map_embed_url: GOOGLE,
      map_pin_lat: "36.265500",
      map_pin_lng: "29.414712",
    });
    expect((await audits(ws2, "property.updated")).at(-1)).toEqual({ fields: ["map"] });
    const v = await villa();
    expect(v?.map).toEqual({
      kind: "pin",
      lat: 36.2655,
      lng: 29.414712,
      openUrl: "https://www.google.com/maps/search/?api=1&query=36.265500,29.414712",
    });
    expect(JSON.stringify(v)).not.toContain("maps/embed");

    // Kayıtlı iğne forma geri gelir (sihirbaz yeniden açılınca).
    const raw = propertyToRaw((await as(O2, ws2, (tx) => getProperty(tx, p2)))!);
    expect(raw).toMatchObject({ mapMode: "pin", mapPinLat: "36.2655", mapPinLng: "29.414712" });

    // İğne sürüklendi: yalnız koordinat değişir.
    await as(O2, ws2, (tx, ctx) =>
      saveWizardStep(tx, ctx, p2, "temel", { ...raw, mapPinLat: "36.2701", mapPinLng: "29.4" }),
    );
    expect(await r2()).toMatchObject({ map_pin_lat: "36.270100", map_pin_lng: "29.400000" });

    // Google'a dönülür: eski kod hâlâ kayıtlı; iğne de korunur.
    await as(O2, ws2, (tx, ctx) =>
      saveWizardStep(tx, ctx, p2, "temel", {
        ...raw,
        mapMode: "google",
        mapPinLat: "36.2701",
        mapPinLng: "29.4",
      }),
    );
    expect(await r2()).toMatchObject({
      map_mode: "google",
      map_embed_url: GOOGLE,
      map_pin_lat: "36.270100",
    });
    expect((await villa())?.map).toMatchObject({ kind: "google" });

    // İğne yöntemi seçili ama iğne kaldırıldı → harita gösterilmez.
    await as(O2, ws2, (tx, ctx) =>
      saveWizardStep(tx, ctx, p2, "temel", {
        ...raw,
        mapMode: "pin",
        mapPinLat: "",
        mapPinLng: "",
      }),
    );
    expect(await r2()).toMatchObject({ map_mode: "pin", map_pin_lat: null, map_embed_url: GOOGLE });
    expect((await villa())?.map).toBeNull();

    // Geçersiz koordinat: alan hatası, hiçbir şey yazılmaz.
    const before = await r2();
    const e = await failure(
      as(O2, ws2, (tx, ctx) =>
        saveWizardStep(tx, ctx, p2, "temel", {
          ...raw,
          mapMode: "pin",
          mapPinLat: "95",
          mapPinLng: "29",
        }),
      ),
    );
    expect(Object.keys(e?.fieldErrors ?? {})).toEqual(["mapPinLat"]);
    expect(await r2()).toEqual(before);
    await as(O2, ws2, (tx, ctx) => saveWizardStep(tx, ctx, p2, "temel", basics()));
  });

  it("mesafeler: her alanın birimi bağımsız; kayıt km, misafire seçilen birimle", async () => {
    await as(O2, ws2, (tx, ctx) =>
      saveWizardStep(
        tx,
        ctx,
        p2,
        "temel",
        basics({
          distanceMarketKm: "500",
          distanceMarketUnit: "m",
          distanceBeachKm: "2",
          distanceBeachUnit: "km",
          distanceCenterKm: "1,5",
          distanceCenterUnit: "km",
          distanceHealthKm: "1250",
          distanceHealthUnit: "m",
        }),
      ),
    );
    expect(await r2()).toMatchObject({
      distance_market_km: "0.500",
      distance_market_unit: "m",
      distance_beach_km: "2.000",
      distance_beach_unit: "km",
      distance_center_km: "1.500",
      distance_center_unit: "km",
      distance_health_km: "1.250",
      distance_health_unit: "m",
    });
    const d = (await villa())!.distances;
    expect(d.find((x) => x.key === "distanceMarketKm")).toEqual({
      key: "distanceMarketKm",
      km: 0.5,
      unit: "m",
    });
    expect(d.find((x) => x.key === "distanceBeachKm")).toEqual({
      key: "distanceBeachKm",
      km: 2,
      unit: "km",
    });
    const raw = propertyToRaw((await as(O2, ws2, (tx) => getProperty(tx, p2)))!);
    expect(raw).toMatchObject({
      distanceMarketKm: "500",
      distanceMarketUnit: "m",
      distanceBeachKm: "2",
      distanceBeachUnit: "km",
      distanceCenterKm: "1,5",
      distanceHealthKm: "1250",
      distanceHealthUnit: "m",
    });
    // Yalnız bir alanın birimi değişir: diğerleri aynı kalır; denetimde yalnız "distances".
    await as(O2, ws2, (tx, ctx) =>
      saveWizardStep(tx, ctx, p2, "temel", {
        ...raw,
        distanceBeachKm: "2000",
        distanceBeachUnit: "m",
      }),
    );
    expect(await r2()).toMatchObject({
      distance_beach_km: "2.000",
      distance_beach_unit: "m",
      distance_market_unit: "m",
      distance_center_unit: "km",
    });
    expect((await audits(ws2, "property.updated")).at(-1)).toEqual({ fields: ["distances"] });
  });

  it("eski kayıt (Revizyon 2 öncesi): yöntem ve birim NULL; görünüm aynı, başka adım kaydı değişiklik saymaz", async () => {
    await admin.query(
      `update properties set map_mode = null, map_pin_lat = null, map_pin_lng = null,
              distance_market_km = 0.35, distance_market_unit = null,
              distance_beach_km = 2.5, distance_beach_unit = null,
              distance_center_km = null, distance_center_unit = null,
              distance_health_km = null, distance_health_unit = null,
              cancellation_policy = 'Eski iptal metni', payment_terms = 'Eski ödeme metni'
        where id = $1`,
      [p2],
    );
    const v = (await villa())!;
    expect(v.map).toMatchObject({ kind: "google", embedUrl: GOOGLE });
    expect(v.distances).toEqual([
      { key: "distanceMarketKm", km: 0.35, unit: null },
      { key: "distanceBeachKm", km: 2.5, unit: null },
      { key: "distanceAirportDlmKm", km: 112, unit: "km" },
    ]);
    expect(v).not.toHaveProperty("cancellationPolicy");
    expect(v).not.toHaveProperty("paymentTerms");
    expect(JSON.stringify(v)).not.toMatch(/Eski iptal|Eski ödeme/);
    const raw = propertyToRaw((await as(O2, ws2, (tx) => getProperty(tx, p2)))!);
    expect(raw).toMatchObject({
      mapMode: "google",
      distanceMarketKm: "350",
      distanceMarketUnit: "m",
      distanceBeachKm: "2,5",
      distanceBeachUnit: "km",
    });
    // Başka adımın kaydı: mülk satırı yazılsa da harita/mesafe "değişti" sayılmaz.
    const n = (await audits(ws2, "property.updated")).length;
    await as(O2, ws2, (tx, ctx) =>
      saveWizardStep(tx, ctx, p2, "aciklama", { description: "<p>Rev2</p>", youtubeUrl: "" }),
    );
    const last = (await audits(ws2, "property.updated")).slice(n);
    expect(last).toEqual([{ fields: ["description"] }]);
    // Değerler korunur (km aynı); birim artık açıkça yazılı ve görünüm değişmez.
    expect(await r2()).toMatchObject({
      map_mode: "google",
      distance_market_km: "0.350",
      distance_market_unit: "m",
      distance_beach_km: "2.500",
      distance_beach_unit: "km",
      // Kaldırılan alanların verisi bu aşamada veritabanında durur (daraltma migration'ı ayrı).
      cancellation_policy: "Eski iptal metni",
      payment_terms: "Eski ödeme metni",
    });
    const pp = (await as(O2, ws2, (tx) => getPublicProfile(tx, p2)))!;
    expect(pp).not.toHaveProperty("cancellationPolicy");
  });

  it("kaldırılan kural ve dahil olan anahtarlar: eski kayıtta gösterilmez, yeni kayıtta kabul edilmez, 4. adım kaydıyla düşer", async () => {
    await admin.query(
      `update properties set house_rule_keys = '{kimlik-zorunlu,parti-yok,havuz-gozetim}',
              price_includes = '{temizlik,su,isitma}' where id = $1`,
      [p2],
    );
    const pp = (await as(O2, ws2, (tx) => getPublicProfile(tx, p2)))!;
    expect(pp.houseRuleKeys).toEqual(["parti-yok"]);
    expect(pp.priceIncludes).toEqual(["su"]);
    const v = (await villa())!;
    expect(v.houseRuleKeys).toEqual(["parti-yok"]);
    expect(v.priceIncludes).toEqual(["su"]);
    // Başka adımın kaydı listelere dokunmaz.
    await as(O2, ws2, (tx, ctx) =>
      saveWizardStep(tx, ctx, p2, "olanaklar", {
        amenities: ["wifi"],
        poolSwimming: "no",
        poolIndoor: "no",
        poolKids: "no",
      }),
    );
    expect(await r2()).toMatchObject({
      house_rule_keys: ["kimlik-zorunlu", "parti-yok", "havuz-gozetim"],
    });
    // Kaldırılan anahtar yeni kayıtta reddedilir.
    for (const [field, key] of [
      ["houseRuleKeys", "kimlik-zorunlu"],
      ["houseRuleKeys", "havuz-gozetim"],
      ["priceIncludes", "temizlik"],
      ["priceIncludes", "isitma"],
    ] as const) {
      const e = await failure(
        as(O2, ws2, (tx, ctx) => saveWizardStep(tx, ctx, p2, "konaklama", { [field]: [key] })),
      );
      expect(Object.keys(e?.fieldErrors ?? {}), key).toEqual([field]);
    }
    // 4. adım formu yalnız katalogdakileri gönderir → eski anahtarlar düşer.
    const values = wizardFormValues(
      "konaklama",
      form([
        ["houseRuleKeys", "parti-yok"],
        ["priceIncludes", "su"],
      ]),
    );
    await as(O2, ws2, (tx, ctx) => saveWizardStep(tx, ctx, p2, "konaklama", values));
    expect(await r2()).toMatchObject({ house_rule_keys: ["parti-yok"], price_includes: ["su"] });
  });

  it("veritabanı kısıtları: yöntem/iğne/birim tutarlılığı (uygulama dışı yazma da reddedilir)", async () => {
    const bad = [
      "map_mode = 'uydu'",
      "map_mode = ''",
      "map_pin_lat = 36.2, map_pin_lng = null",
      "map_pin_lat = 0, map_pin_lng = 0",
      "map_pin_lat = 91, map_pin_lng = 29",
      "distance_market_unit = 'mil'",
      "distance_center_km = null, distance_center_unit = 'km'",
    ];
    for (const set of bad) {
      const code = await admin.query(`update properties set ${set} where id = $1`, [p2]).then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
      expect(code, set).toBe("23514");
    }
  });

  it("yetkiler: app_user yeni kolonlara INSERT + UPDATE; staff yazamaz (RLS değişmedi)", async () => {
    const res = await admin.query(`
      select c.col,
             has_column_privilege('app_user', 'public.properties', c.col, 'UPDATE') as upd,
             has_column_privilege('app_user', 'public.properties', c.col, 'INSERT') as ins
        from unnest(array['map_mode', 'map_pin_lat', 'map_pin_lng', 'distance_market_unit',
                          'distance_restaurant_unit', 'distance_center_unit', 'distance_beach_unit',
                          'distance_airport_ayt_unit', 'distance_airport_dlm_unit',
                          'distance_health_unit']) as c(col)`);
    expect(res.rows).toHaveLength(10);
    for (const r of res.rows) expect(r, r.col).toMatchObject({ upd: true, ins: true });
    const e = await failure(
      as(S2, ws2, (tx, ctx) => saveWizardStep(tx, ctx, p2, "temel", basics({ mapMode: "pin" }))),
    );
    expect(e?.code).toBe("FORBIDDEN");
    // Staff doğrudan SQL ile de yazamaz: RLS satırı göstermez (0 satır) ya da yetki hatası.
    const before = await r2();
    const raw = await as(S2, ws2, (tx) =>
      tx.execute(sql`update properties set map_mode = null where id = ${p2}`),
    ).then(
      (r) => r.rowCount ?? 0,
      () => 0,
    );
    expect(raw).toBe(0);
    expect(await r2()).toEqual(before);
  });
});
