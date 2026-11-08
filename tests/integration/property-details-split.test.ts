import { randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { plainTextToHtml } from "@/lib/rich-text";
import { photoPrefix } from "@/server/properties/photos";
import { propertyToRaw, updatePropertyFields } from "@/server/properties/property-fields";
import {
  getPublicProfile,
  publishProperty,
  updatePublicProfile,
  updatePublicSlug,
  updateStayDetails,
} from "@/server/properties/public-profile";
import { createProperty, getProperty, updateProperty } from "@/server/properties/service";
import { getPublicVilla } from "@/server/public/villa";
import { createMemoryStorage } from "@/server/storage/memory";
import { updateWorkspaceWhatsapp } from "@/server/workspaces/contact";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

/**
 * Panel yeniden tasarımı – Aşama 2: mülk bilgileri ile yayın ayarlarının ayrılması (gerçek
 * PostgreSQL, app_user). Şema ve migration değişmedi; yalnız servis ayrımı:
 *  - updateStayDetails: olanaklar + konaklama bilgileri (adres ve yayın durumu korunur);
 *  - updatePublicSlug: yalnız sayfa adresi (yayındaki adres onayı aynen);
 *  - updatePropertyFields: mülk alanlarından yalnız verilenler (diğerleri korunur; eski düz metin
 *    açıklama kaybolmaz).
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
      `select name, max_guests, district, description, description_html, latitude::text, longitude::text,
              pool_swimming, pool_swimming_depth::text, pool_swimming_protected, youtube_video_ids,
              public_slug, is_public, public_published_at, amenities, check_in_time::text,
              check_out_time::text, house_rules, cancellation_policy, payment_terms, updated_at
         from properties where id = $1`,
      [id],
    )
  ).rows[0];
const audits = async (ws: string, action: string) =>
  (
    await admin.query(
      "select metadata from audit_log where workspace_id = $1 and action = $2 order by occurred_at, id",
      [ws, action],
    )
  ).rows.map((r) => r.metadata);

const STAY = {
  amenities: ["otopark", "wifi", "deniz-manzarasi"],
  checkInTime: "16:00",
  checkOutTime: "10:30",
  houseRules: "Sessiz saatler 23:00 sonrası.\nEvcil hayvan kabul edilmez.",
  cancellationPolicy: "30 gün önce ücretsiz.",
  paymentTerms: "%30 ön ödeme.",
};

let O: U, M: U, S: U;
let ws: string, prop: string;

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("a2owner");
  M = await mkUser("a2manager");
  S = await mkUser("a2staff");
  ws = (await createWorkspace(app, { userId: O.id, name: "A2 İşletme", slug: `a2-${tag}` })).id;
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
  prop = await as(O, ws, (tx, ctx) =>
    createProperty(tx, ctx, {
      name: "Defne Villa",
      propertyType: "villa",
      maxGuests: "8",
      bedrooms: "4",
      bathrooms: "3",
      province: "Antalya",
      district: "Kaş",
      neighborhood: "Kalkan",
      latitude: "36.265512",
      longitude: "29.414301",
      description: "<p>Denize <strong>400 m</strong>.</p>",
      youtubeUrls: ["https://youtu.be/aBcDeFgHiJ0"],
      poolSwimming: "yes",
      poolSwimmingDepth: "1,55",
      poolSwimmingWidth: "4",
      poolSwimmingLength: "9,25",
      poolSwimmingProtected: "yes",
    }),
  );
  await as(O, ws, (tx, ctx) =>
    updatePublicSlug(tx, ctx, prop, { publicSlug: `a2-villa-${tag}`, confirmSlugChange: false }),
  );
});

afterAll(async () => {
  await admin.end();
  await appPool.end();
});

describe("olanaklar ve konaklama bilgileri (updateStayDetails)", () => {
  it("doğru kaydedilir; adres, yayın durumu ve mülk alanları değişmez; denetimde yalnız alan adları", async () => {
    const before = await row(prop);
    const r = await as(O, ws, (tx, ctx) => updateStayDetails(tx, ctx, prop, STAY));
    expect(r.changed).toBe(6);
    const after = await row(prop);
    expect(after).toMatchObject({
      amenities: ["wifi", "otopark", "deniz-manzarasi"], // katalog sırası
      check_in_time: "16:00:00",
      check_out_time: "10:30:00",
      house_rules: STAY.houseRules,
      cancellation_policy: STAY.cancellationPolicy,
      payment_terms: STAY.paymentTerms,
    });
    for (const k of [
      "name",
      "max_guests",
      "district",
      "description_html",
      "latitude",
      "longitude",
      "pool_swimming_depth",
      "pool_swimming_protected",
      "youtube_video_ids",
      "public_slug",
      "is_public",
      "public_published_at",
    ]) {
      expect(after[k], k).toEqual(before[k]);
    }
    expect((await audits(ws, "property.public_profile_updated")).at(-1)).toEqual({
      fields: [
        "amenities",
        "check_in_time",
        "check_out_time",
        "house_rules",
        "cancellation_policy",
        "payment_terms",
      ],
    });
    expect(await audits(ws, "property.updated")).toEqual([]);
  });

  it("aynı değerler: değişiklik ve denetim kaydı yok; tek alanı temizlemek yalnız onu değiştirir", async () => {
    const n = (await audits(ws, "property.public_profile_updated")).length;
    expect((await as(O, ws, (tx, ctx) => updateStayDetails(tx, ctx, prop, STAY))).changed).toBe(0);
    expect((await audits(ws, "property.public_profile_updated")).length).toBe(n);
    const r = await as(M, ws, (tx, ctx) =>
      updateStayDetails(tx, ctx, prop, { ...STAY, paymentTerms: "" }),
    );
    expect(r.changed).toBe(1);
    const after = await row(prop);
    expect(after.payment_terms).toBeNull();
    expect(after.house_rules).toBe(STAY.houseRules);
    expect((await audits(ws, "property.public_profile_updated")).at(-1)).toEqual({
      fields: ["payment_terms"],
    });
  });

  it("geçersiz değerler alan hatasıyla reddedilir, hiçbir şey yazılmaz", async () => {
    const before = await row(prop);
    const err = await as(O, ws, (tx, ctx) =>
      updateStayDetails(tx, ctx, prop, {
        ...STAY,
        amenities: ["yok-boyle"],
        checkInTime: "25:00",
      }),
    ).then(
      () => null,
      (e: { code?: string; fieldErrors?: Record<string, string[]> }) => e,
    );
    expect(err?.code).toBe("VALIDATION");
    expect(Object.keys(err?.fieldErrors ?? {}).sort()).toEqual(["amenities", "checkInTime"]);
    expect(await row(prop)).toEqual(before);
  });

  it("staff yazamaz (servis); veri değişmez", async () => {
    const before = await row(prop);
    const code = await as(S, ws, (tx, ctx) =>
      updateStayDetails(tx, ctx, prop, { ...STAY, houseRules: "staff" }),
    ).then(
      () => "ok",
      (e: { code?: string }) => e.code,
    );
    expect(code).toBe("FORBIDDEN");
    expect(await row(prop)).toEqual(before);
  });
});

describe("sayfa adresi (updatePublicSlug)", () => {
  it("yalnız adres değişir; olanaklar ve konaklama bilgileri korunur", async () => {
    const before = await row(prop);
    const r = await as(M, ws, (tx, ctx) =>
      updatePublicSlug(tx, ctx, prop, { publicSlug: ` A2-Yeni-${tag} `, confirmSlugChange: false }),
    );
    expect(r.changed).toBe(1);
    const after = await row(prop);
    expect(after.public_slug).toBe(`a2-yeni-${tag}`);
    for (const k of [
      "amenities",
      "check_in_time",
      "check_out_time",
      "house_rules",
      "cancellation_policy",
      "payment_terms",
      "is_public",
      "name",
    ]) {
      expect(after[k], k).toEqual(before[k]);
    }
    expect((await audits(ws, "property.public_profile_updated")).at(-1)).toEqual({
      fields: ["public_slug"],
    });
  });

  it("geçersiz ve ayrılmış adres reddedilir; staff değiştiremez", async () => {
    for (const bad of ["a--b", "admin", "Ç"]) {
      const code = await as(O, ws, (tx, ctx) =>
        updatePublicSlug(tx, ctx, prop, { publicSlug: bad, confirmSlugChange: false }),
      ).then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
      expect(code, bad).toBe("VALIDATION");
    }
    const code = await as(S, ws, (tx, ctx) =>
      updatePublicSlug(tx, ctx, prop, { publicSlug: `staff-${tag}`, confirmSlugChange: false }),
    ).then(
      () => "ok",
      (e: { code?: string }) => e.code,
    );
    expect(code).toBe("FORBIDDEN");
    expect((await row(prop)).public_slug).toBe(`a2-yeni-${tag}`);
  });

  it("yayındaki adres: onaysız değişmez, boşaltılamaz; onayla değişir. Olanak kaydı onay istemez", async () => {
    const photo = uuidv7();
    await admin.query(
      `insert into property_photos (id, workspace_id, property_id, created_by, storage_prefix, width, height,
         quality, bytes_400, bytes_1200, bytes_2000, is_cover)
       values ($1,$2,$3,$4,$5,1800,1200,82,1,1,1,true)`,
      [photo, ws, prop, O.id, photoPrefix(ws, prop, photo)],
    );
    await as(O, ws, (tx, ctx) => updateWorkspaceWhatsapp(tx, ctx, "0532 111 22 33"));
    await as(O, ws, (tx, ctx) => publishProperty(tx, ctx, prop));
    const slug = `a2-yeni-${tag}`;
    const fe = (input: unknown) =>
      as(O, ws, (tx, ctx) => updatePublicSlug(tx, ctx, prop, input)).then(
        () => ({}),
        (e: { fieldErrors?: Record<string, string[]> }) => e.fieldErrors ?? {},
      );
    expect(Object.keys(await fe({ publicSlug: `baska-${tag}`, confirmSlugChange: false }))).toEqual(
      ["confirmSlugChange"],
    );
    expect(Object.keys(await fe({ publicSlug: "", confirmSlugChange: true }))).toEqual([
      "publicSlug",
    ]);
    expect((await row(prop)).public_slug).toBe(slug);
    // Yayındayken olanak/konaklama kaydı adres onayı istemez ve adresi değiştirmez.
    const r = await as(O, ws, (tx, ctx) =>
      updateStayDetails(tx, ctx, prop, { ...STAY, paymentTerms: "", checkOutTime: "11:00" }),
    );
    expect(r.changed).toBe(1);
    expect(await row(prop)).toMatchObject({ public_slug: slug, is_public: true });
    await as(O, ws, (tx, ctx) =>
      updatePublicSlug(tx, ctx, prop, { publicSlug: `a2-son-${tag}`, confirmSlugChange: "on" }),
    );
    expect(await row(prop)).toMatchObject({ public_slug: `a2-son-${tag}`, is_public: true });
  });

  it("public villa sayfası yeni adres ve olanaklarla çalışır; eski adres 404", async () => {
    const storage = createMemoryStorage("https://img.test.invalid");
    const v = await getPublicVilla(app, storage, `a2-son-${tag}`);
    expect(v).toMatchObject({
      name: "Defne Villa",
      amenities: ["wifi", "otopark", "deniz-manzarasi"],
      checkInTime: "16:00",
      checkOutTime: "11:00",
      houseRules: STAY.houseRules,
    });
    expect(await getPublicVilla(app, storage, `a2-yeni-${tag}`)).toBeNull();
  });

  it("uyumluluk: birleşik updatePublicProfile çalışmaya devam eder", async () => {
    const r = await as(O, ws, (tx, ctx) =>
      updatePublicProfile(tx, ctx, prop, {
        publicSlug: `a2-son-${tag}`,
        ...STAY,
        houseRules: "Birleşik form.",
        confirmSlugChange: false,
      }),
    );
    expect(r.changed).toBe(3); // ev kuralları, çıkış saati (10:30) ve ödeme koşulları
    const p = await as(O, ws, (tx) => getPublicProfile(tx, prop));
    expect(p).toMatchObject({ houseRules: "Birleşik form.", checkOutTime: "10:30" });
  });
});

describe("mülk alanlarını parça parça kaydetme (updatePropertyFields)", () => {
  it("kayıt → form değerleri kayıpsız: değişiklik yoksa güncelleme ve denetim kaydı yok", async () => {
    const p = (await as(O, ws, (tx) => getProperty(tx, prop)))!;
    const raw = propertyToRaw(p);
    expect(raw).toMatchObject({
      latitude: "36.265512",
      longitude: "29.414301",
      poolSwimming: "yes",
      poolSwimmingDepth: "1,55",
      poolSwimmingLength: "9,25",
      poolSwimmingProtected: "yes",
      youtubeUrls: ["https://www.youtube.com/watch?v=aBcDeFgHiJ0"],
    });
    const before = await row(prop);
    expect((await as(O, ws, (tx, ctx) => updateProperty(tx, ctx, prop, raw))).changed).toBe(0);
    expect((await as(O, ws, (tx, ctx) => updatePropertyFields(tx, ctx, prop, {}))).changed).toBe(0);
    expect(await row(prop)).toEqual(before);
    expect(await audits(ws, "property.updated")).toEqual([]);
  });

  it("yalnız verilen alan değişir; havuz, koordinat, açıklama, video ve sayfa ayarları korunur", async () => {
    const before = await row(prop);
    const r = await as(M, ws, (tx, ctx) =>
      updatePropertyFields(tx, ctx, prop, { name: "Defne Konak", maxGuests: "10", bogus: "x" }),
    );
    expect(r.changed).toBe(2);
    const after = await row(prop);
    expect(after).toMatchObject({ name: "Defne Konak", max_guests: 10 });
    for (const k of [
      "district",
      "description",
      "description_html",
      "latitude",
      "longitude",
      "pool_swimming",
      "pool_swimming_depth",
      "pool_swimming_protected",
      "youtube_video_ids",
      "public_slug",
      "is_public",
      "amenities",
      "house_rules",
    ]) {
      expect(after[k], k).toEqual(before[k]);
    }
    expect((await audits(ws, "property.updated")).at(-1)).toEqual({
      fields: ["name", "max_guests"],
    });
  });

  it("doğrulama aynen geçerli; staff yazamaz", async () => {
    const before = await row(prop);
    const v = await as(O, ws, (tx, ctx) =>
      updatePropertyFields(tx, ctx, prop, { maxGuests: "0", poolSwimmingDepth: "" }),
    ).then(
      () => null,
      (e: { code?: string; fieldErrors?: Record<string, string[]> }) => e,
    );
    expect(v?.code).toBe("VALIDATION");
    expect(Object.keys(v?.fieldErrors ?? {}).sort()).toEqual(["maxGuests", "poolSwimmingDepth"]);
    const code = await as(S, ws, (tx, ctx) =>
      updatePropertyFields(tx, ctx, prop, { name: "Staff" }),
    ).then(
      () => "ok",
      (e: { code?: string }) => e.code,
    );
    expect(code).toBe("FORBIDDEN");
    expect(await row(prop)).toEqual(before);
  });

  it("eski düz metin açıklama başka alan kaydedilirken kaybolmaz (HTML'e çevrilir, metin aynı)", async () => {
    const legacy = "Bahçeli taş ev.\nDenize 5 dakika.\n\nSessiz bir köyde <eski> kayıt & not.";
    await admin.query(
      "update properties set description = $1, description_html = null where id = $2",
      [legacy, prop],
    );
    const p = (await as(O, ws, (tx) => getProperty(tx, prop)))!;
    expect(p.descriptionHtml).toBe(plainTextToHtml(legacy));
    expect(propertyToRaw(p).description).toBe(plainTextToHtml(legacy));

    const n = (await audits(ws, "property.updated")).length;
    await as(O, ws, (tx, ctx) => updatePropertyFields(tx, ctx, prop, { bathrooms: "4" }));
    const after = await row(prop);
    expect(after.description_html).toBe(plainTextToHtml(legacy));
    expect(after.description).toContain("Bahçeli taş ev.");
    expect(after.description).toContain("Denize 5 dakika.");
    expect(after.description).toContain("Sessiz bir köyde <eski> kayıt & not.");
    // Açıklama değişmiş sayılmaz: denetim kaydında yalnız banyo.
    const last = (await audits(ws, "property.updated")).at(-1);
    expect((await audits(ws, "property.updated")).length).toBe(n + 1);
    expect(last).toEqual({ fields: ["bathrooms"] });
    // Olanak/konaklama kaydı da açıklamaya dokunmaz.
    await as(O, ws, (tx, ctx) => updateStayDetails(tx, ctx, prop, { ...STAY, houseRules: "X." }));
    expect((await row(prop)).description_html).toBe(plainTextToHtml(legacy));
  });
});
