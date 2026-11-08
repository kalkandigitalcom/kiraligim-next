import { randomBytes } from "node:crypto";

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
import { saveWizardStep, updateStayFields } from "@/server/properties/property-fields";
import { publishProperty, updatePublicSlug } from "@/server/properties/public-profile";
import { createProperty } from "@/server/properties/service";
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
              beds_double, beds_single, beds_sofa, address_line, postal_code, latitude::text,
              longitude::text, tourism_license_no, description, description_html, youtube_video_ids,
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
  ["bedsDouble", "2"],
  ["bedsSingle", "2"],
  ["bedsSofa", "1"],
  ["addressLine", "Kalkan Mah. 12. Sok. No 4"],
  ["postalCode", "07960"],
  ["latitude", "36.265512"],
  ["longitude", "29.414301"],
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
      beds_sofa: 1,
      address_line: "Kalkan Mah. 12. Sok. No 4",
      postal_code: "07960",
      latitude: "36.265512",
      tourism_license_no: "07-1234",
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
  it("2. adım: açıklama ve videolar; başka hiçbir alan değişmez", async () => {
    const before = await row(prop);
    const values = wizardFormValues(
      "aciklama",
      form([
        ["description", "<p>Denize <strong>400 m</strong>.</p>"],
        ["youtubeUrls", "https://youtu.be/aBcDeFgHiJ0"],
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
        ["cancellationPolicy", ""],
        ["paymentTerms", "%30 ön ödeme."],
        ["amenities", "jakuzi"], // başka adımın alanı: okunmaz
      ]),
    );
    const r = await as(O, ws, (tx, ctx) => saveWizardStep(tx, ctx, prop, "konaklama", values));
    expect(r.changed).toBe(2);
    const after = await row(prop);
    expect(diff(before, after)).toEqual(["cancellation_policy", "check_in_time"]);
    expect(after).toMatchObject({
      check_in_time: "15:00:00",
      cancellation_policy: null,
      amenities: ["wifi", "otopark"],
      public_slug: `a3-villa-${tag}`,
    });
  });

  it("1. adım: temel bilgiler; açıklama, havuz ve konaklama bilgileri korunur", async () => {
    const before = await row(prop);
    const values = wizardFormValues(
      "temel",
      form(BASICS.map(([k, v]) => [k, k === "maxGuests" ? "10" : k === "postalCode" ? "" : v])),
    );
    const r = await as(M, ws, (tx, ctx) => saveWizardStep(tx, ctx, prop, "temel", values));
    expect(r.changed).toBe(2);
    expect(diff(before, await row(prop))).toEqual(["max_guests", "postal_code"]);
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
      saveWizardStep(tx, ctx, prop, "konaklama", { cancellationPolicy: "14 gün önce ücretsiz." }),
    );
    await as(M, ws, (tx, ctx) =>
      saveWizardStep(tx, ctx, prop, "temel", Object.fromEntries(BASICS)),
    );
    expect(await row(prop)).toMatchObject({
      is_public: true,
      public_slug: `a3-villa-${tag}`,
      cancellation_policy: "14 gün önce ücretsiz.",
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
