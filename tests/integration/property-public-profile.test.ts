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
import { photoPrefix } from "@/server/properties/photos";
import {
  getPublicProfile,
  publishProperty,
  unpublishProperty,
  updatePublicProfile,
} from "@/server/properties/public-profile";
import { createProperty, setPropertyStatus, updateProperty } from "@/server/properties/service";
import { getWorkspaceWhatsapp, updateWorkspaceWhatsapp } from "@/server/workspaces/contact";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

/**
 * Aşama F1: villa sayfası altyapısı (0022, 0023) — gerçek PostgreSQL. Uygulama işlemleri yalnız
 * app_user ile; yönetici bağlantısı kurulum ve doğrulama içindir. RLS politikaları değişmedi:
 * mevcut properties/workspaces politikalarının yeni kolonları da koruduğu doğrulanır.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 8 });
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
const mkWorkspace = async (owner: U, label: string) =>
  (await createWorkspace(app, { userId: owner.id, name: `${label} İş`, slug: `${label}-${tag}` }))
    .id;
const as = <T>(u: U, ws: string, fn: (tx: Tx, ctx: TenantContext) => Promise<T>) =>
  withTenant(app, { userId: u.id, workspaceId: ws }, fn);
const mkProperty = (u: U, ws: string, name = "Deniz Villa") =>
  as(u, ws, (tx, ctx) =>
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
const addPhoto = (u: U, ws: string, property: string) =>
  as(u, ws, async (tx) => {
    const id = uuidv7();
    await tx.execute(sql`
      insert into property_photos (id, workspace_id, property_id, created_by, storage_prefix, width,
                                   height, quality, bytes_400, bytes_1200, bytes_2000)
      values (${id}, ${ws}, ${property}, app_current_user_id(), ${photoPrefix(ws, property, id)},
              100, 100, 82, 1, 1, 1)`);
  });

const rowOf = async (id: string) =>
  (
    await admin.query(
      `select public_slug, is_public, public_published_at, amenities, check_in_time::text as cin,
              check_out_time::text as cout, house_rules, cancellation_policy, payment_terms
         from properties where id = $1`,
      [id],
    )
  ).rows[0];
const auditOf = async (ws: string, action: string) =>
  (
    await admin.query(
      "select actor_user_id, target_id, metadata from audit_log where workspace_id = $1 and action = $2 order by occurred_at, id",
      [ws, action],
    )
  ).rows;
const failure = (p: Promise<unknown>) =>
  p.then(
    () => ({ code: "ok", message: "", fields: {} as Record<string, string[]> }),
    (err: { code?: string; message?: string; fieldErrors?: Record<string, string[]> }) => ({
      code: err.code ?? pgErrorInfo(err).code ?? "?",
      message: err.message ?? "",
      fields: err.fieldErrors ?? {},
    }),
  );
const pgFail = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (err: unknown) => {
      const e = pgErrorInfo(err);
      return `${e.code}:${e.constraint ?? ""}`;
    },
  );

const profile = (over: Record<string, unknown> = {}) => ({
  publicSlug: `villa-a-${tag}`,
  amenities: ["wifi", "klima", "otopark"],
  checkInTime: "16:00",
  checkOutTime: "10:00",
  houseRules: "Evcil hayvan kabul edilmez.\nSessizlik 23:00'ten sonra.",
  cancellationPolicy: "30 gün öncesine kadar ücretsiz iptal.",
  paymentTerms: "%30 ön ödeme.",
  ...over,
});

let O: U, M: U, S: U, B: U;
let wsA: string, wsB: string, propA: string, propB: string;

beforeAll(async () => {
  await admin.connect();
  [O, M, S, B] = (await Promise.all(["yoya", "ymert", "yselin", "ybaris"].map(mkUser))) as [
    U,
    U,
    U,
    U,
  ];
  wsA = await mkWorkspace(O, "ya");
  wsB = await mkWorkspace(B, "yb");
  await as(O, wsA, async (tx, ctx) => {
    await addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" });
    await addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" });
  });
  propA = await mkProperty(O, wsA);
  propB = await mkProperty(B, wsB, "Zeytin Ev");
});

afterAll(async () => {
  await admin.end();
  await appPool.end();
});

describe("varsayılanlar ve yetkiler (0022, 0023)", () => {
  it("yeni mülk taslak: adres yok, yayında değil, olanak yok", async () => {
    expect(await rowOf(propA)).toMatchObject({
      public_slug: null,
      is_public: false,
      public_published_at: null,
      amenities: [],
      cin: null,
      house_rules: null,
    });
    const p = await as(S, wsA, (tx) => getPublicProfile(tx, propA));
    expect(p).toMatchObject({
      isPublic: false,
      photoCount: 0,
      whatsapp: null,
      subscriptionCurrent: true,
      visibility: { state: "draft", unmet: ["slug", "photo", "whatsapp"] },
    });
  });

  it("app_user: yeni kolonlarda yalnız UPDATE (INSERT yok); RLS politikaları değişmedi", async () => {
    const res = await admin.query(`
      select c.col,
             has_column_privilege('app_user', 'public.' || c.tbl, c.col, 'UPDATE') as upd,
             has_column_privilege('app_user', 'public.' || c.tbl, c.col, 'INSERT') as ins
        from (values ('properties', 'public_slug'), ('properties', 'is_public'),
                     ('properties', 'public_published_at'), ('properties', 'amenities'),
                     ('properties', 'check_in_time'), ('properties', 'check_out_time'),
                     ('properties', 'house_rules'), ('properties', 'cancellation_policy'),
                     ('properties', 'payment_terms'), ('workspaces', 'contact_whatsapp')) as c(tbl, col)`);
    for (const r of res.rows) expect(r, r.col).toMatchObject({ upd: true, ins: false });
    const pol = await admin.query(
      `select polname from pg_policy where polrelid in ('public.properties'::regclass, 'public.workspaces'::regclass) order by polname`,
    );
    expect(pol.rows.map((r) => r.polname)).toEqual([
      "properties_api_fn", // 0052: app_migrator, yalnız SELECT (acente API'si, app.api_fn)
      "properties_ical_export_read", // 0029 (3.1): app_migrator, yalnız SELECT (iCal akışı)
      "properties_insert",
      "properties_public_read", // 0024 (F2a): app_migrator, yalnız SELECT
      "properties_select",
      "properties_update",
      "properties_wa_calendar_read", // 0036 (A2): app_migrator, yalnız SELECT (app.wa_calendar)
      "workspaces_api_fn", // 0052: app_migrator, yalnız SELECT (app.api_fn)
      "workspaces_ical_export_read", // 0029 (3.1): app_migrator, yalnız SELECT
      "workspaces_ical_sync_read", // 0029 (3.1): app_migrator, yalnız SELECT (cron)
      "workspaces_insert",
      "workspaces_public_read", // 0024 (F2a): app_migrator, yalnız SELECT
      "workspaces_select",
      "workspaces_update",
      "workspaces_wa_read", // 0031 (A1): app_migrator, yalnız SELECT (app.wa_fn)
    ]);
  });
});

describe("sayfa ayarları", () => {
  it("owner kaydeder; denetim kaydında yalnız alan adları", async () => {
    const r = await as(O, wsA, (tx, ctx) => updatePublicProfile(tx, ctx, propA, profile()));
    expect(r.changed).toBe(5);
    expect(await rowOf(propA)).toMatchObject({
      public_slug: `villa-a-${tag}`,
      amenities: ["klima", "wifi", "otopark"], // katalog sırası (Revizyon 2 kategorileri)
      cin: "16:00:00",
      cout: "10:00:00",
      // Revizyon 2: iptal / ödeme koşulları artık yazılmaz (gönderilse de yok sayılır).
      cancellation_policy: null,
      payment_terms: null,
      is_public: false,
    });
    const audit = (await auditOf(wsA, "property.public_profile_updated")).at(-1);
    expect(audit).toMatchObject({ actor_user_id: O.id, target_id: propA });
    expect(audit.metadata.fields).toEqual([
      "public_slug",
      "amenities",
      "check_in_time",
      "check_out_time",
      "house_rules",
    ]);
    expect(JSON.stringify(audit.metadata)).not.toMatch(/villa-a|Evcil|%30/);
  });

  it("aynı değerlerle kaydetmek değişiklik sayılmaz (olanak sırası önemsiz)", async () => {
    const before = (await auditOf(wsA, "property.public_profile_updated")).length;
    const r = await as(M, wsA, (tx, ctx) =>
      updatePublicProfile(tx, ctx, propA, profile({ amenities: ["otopark", "wifi", "klima"] })),
    );
    expect(r.changed).toBe(0);
    expect((await auditOf(wsA, "property.public_profile_updated")).length).toBe(before);
  });

  it("manager düzenleyebilir; staff düzenleyemez (servis + RLS)", async () => {
    const r = await as(M, wsA, (tx, ctx) =>
      updatePublicProfile(tx, ctx, propA, profile({ checkOutTime: "11:00" })),
    );
    expect(r.changed).toBe(1);
    expect(
      (await failure(as(S, wsA, (tx, ctx) => updatePublicProfile(tx, ctx, propA, profile())))).code,
    ).toBe("FORBIDDEN");
    const raw = await as(S, wsA, (tx) =>
      tx.execute(sql`update properties set house_rules = 'x' where id = ${propA}`),
    );
    expect(raw.rowCount).toBe(0);
  });

  it("adres tüm işletmeler arasında benzersiz", async () => {
    const f = await failure(
      as(B, wsB, (tx, ctx) =>
        updatePublicProfile(tx, ctx, propB, profile({ publicSlug: `villa-a-${tag}` })),
      ),
    );
    expect(f.code).toBe("VALIDATION");
    expect(f.fields.publicSlug?.[0]).toMatch(/kullanımda/);
    expect(
      (
        await as(B, wsB, (tx, ctx) =>
          updatePublicProfile(tx, ctx, propB, profile({ publicSlug: `zeytin-${tag}` })),
        )
      ).changed,
    ).toBeGreaterThan(0);
  });

  it("veritabanı son savunma: biçim, ayrılmış adres, olanak biçimi, saniyeli saat, kontrol karakteri", async () => {
    const raw = (frag: ReturnType<typeof sql>) =>
      pgFail(
        as(O, wsA, (tx) => tx.execute(sql`update properties set ${frag} where id = ${propA}`)),
      );
    expect(await raw(sql`public_slug = 'admin'`)).toBe("23514:properties_public_slug_format");
    expect(await raw(sql`public_slug = 'a--b-c'`)).toBe("23514:properties_public_slug_format");
    expect(await raw(sql`public_slug = 'Buyuk'`)).toBe("23514:properties_public_slug_format");
    expect(await raw(sql`amenities = array['Wi Fi']`)).toBe("23514:properties_amenities");
    expect(await raw(sql`check_in_time = '16:00:30'`)).toBe("23514:properties_stay_times");
    expect(await raw(sql`house_rules = ${"a\u0007b"}`)).toBe("23514:properties_public_texts");
    expect(await raw(sql`house_rules = ''`)).toBe("23514:properties_public_texts");
    expect(await raw(sql`is_public = true, public_slug = null`)).toBe(
      "23514:properties_public_requires_slug",
    );
  });

  it("başka işletmenin mülkü görülmez ve değiştirilemez", async () => {
    expect(await as(B, wsB, (tx) => getPublicProfile(tx, propA))).toBeNull();
    expect(
      (await failure(as(B, wsB, (tx, ctx) => updatePublicProfile(tx, ctx, propA, profile())))).code,
    ).toBe("NOT_FOUND");
    expect((await failure(as(B, wsB, (tx, ctx) => publishProperty(tx, ctx, propA)))).code).toBe(
      "NOT_FOUND",
    );
    const raw = await as(B, wsB, (tx) =>
      tx.execute(sql`update properties set is_public = false where id = ${propA}`),
    );
    expect(raw.rowCount).toBe(0);
  });

  it("mevcut mülk düzenleme sayfa alanlarına dokunmaz", async () => {
    await as(O, wsA, (tx, ctx) =>
      updateProperty(tx, ctx, propA, {
        name: "Deniz Villa Yeni",
        propertyType: "villa",
        maxGuests: "8",
        bedrooms: "3",
        bathrooms: "2",
        province: "Antalya",
        district: "Kaş",
      }),
    );
    expect(await rowOf(propA)).toMatchObject({
      public_slug: `villa-a-${tag}`,
      amenities: ["klima", "wifi", "otopark"], // katalog sırası (Revizyon 2 kategorileri)
      cout: "11:00:00",
    });
  });
});

describe("WhatsApp numarası (işletme düzeyi, yalnız owner)", () => {
  it("manager ve staff değiştiremez (servis + RLS); owner kaydeder, biçim normalleşir", async () => {
    for (const u of [M, S]) {
      expect(
        (await failure(as(u, wsA, (tx, ctx) => updateWorkspaceWhatsapp(tx, ctx, "05321234567"))))
          .code,
      ).toBe("FORBIDDEN");
      const raw = await as(u, wsA, (tx) =>
        tx.execute(sql`update workspaces set contact_whatsapp = '+905321234567' where id = ${wsA}`),
      );
      expect(raw.rowCount).toBe(0);
    }
    expect(
      (await failure(as(O, wsA, (tx, ctx) => updateWorkspaceWhatsapp(tx, ctx, "12")))).fields
        .whatsapp,
    ).toBeTruthy();
    const r = await as(O, wsA, (tx, ctx) => updateWorkspaceWhatsapp(tx, ctx, "0532 123 45 67"));
    expect(r).toEqual({ changed: true, value: "+905321234567" });
    expect(await as(S, wsA, (tx) => getWorkspaceWhatsapp(tx))).toBe("+905321234567");
    expect(await as(B, wsB, (tx) => getWorkspaceWhatsapp(tx))).toBeNull();
    expect((await auditOf(wsA, "workspace.updated")).at(-1)?.metadata).toEqual({
      fields: ["contact_whatsapp"],
    });
    expect(
      await pgFail(
        as(O, wsA, (tx) =>
          tx.execute(sql`update workspaces set contact_whatsapp = '0532' where id = ${wsA}`),
        ),
      ),
    ).toBe("23514:workspaces_contact_whatsapp_format");
  });
});

describe("yayınlama", () => {
  it("fotoğraf yoksa yayınlanmaz; eksik koşul mesajda", async () => {
    const f = await failure(as(M, wsA, (tx, ctx) => publishProperty(tx, ctx, propA)));
    expect(f.code).toBe("CONFLICT");
    expect(f.message).toMatch(/en az bir fotoğraf/);
    expect((await rowOf(propA)).is_public).toBe(false);
  });

  it("staff yayınlayamaz", async () => {
    await addPhoto(O, wsA, propA);
    expect((await failure(as(S, wsA, (tx, ctx) => publishProperty(tx, ctx, propA)))).code).toBe(
      "FORBIDDEN",
    );
  });

  it("koşullar tamamsa manager yayınlar; tekrar yayınlamak değişiklik değil", async () => {
    expect(await as(M, wsA, (tx, ctx) => publishProperty(tx, ctx, propA))).toEqual({
      changed: true,
    });
    const row = await rowOf(propA);
    expect(row.is_public).toBe(true);
    expect(row.public_published_at).toBeInstanceOf(Date);
    expect(await as(O, wsA, (tx, ctx) => publishProperty(tx, ctx, propA))).toEqual({
      changed: false,
    });
    expect((await auditOf(wsA, "property.published")).length).toBe(1);
    expect(await as(S, wsA, async (tx) => (await getPublicProfile(tx, propA))?.visibility)).toEqual(
      { state: "published" },
    );
  });

  it("yayındaki adres: onaysız değişmez, silinemez; onayla değişir", async () => {
    const f1 = await failure(
      as(O, wsA, (tx, ctx) =>
        updatePublicProfile(
          tx,
          ctx,
          propA,
          profile({ publicSlug: `villa-yeni-${tag}`, checkOutTime: "11:00" }),
        ),
      ),
    );
    expect(f1.fields.confirmSlugChange?.[0]).toMatch(/çalışmayacak/);
    const f2 = await failure(
      as(O, wsA, (tx, ctx) =>
        updatePublicProfile(tx, ctx, propA, profile({ publicSlug: "", confirmSlugChange: true })),
      ),
    );
    expect(f2.fields.publicSlug?.[0]).toMatch(/boş bırakılamaz/);
    await as(O, wsA, (tx, ctx) =>
      updatePublicProfile(
        tx,
        ctx,
        propA,
        profile({
          publicSlug: `villa-yeni-${tag}`,
          checkOutTime: "11:00",
          confirmSlugChange: true,
        }),
      ),
    );
    expect((await rowOf(propA)).public_slug).toBe(`villa-yeni-${tag}`);
  });

  it("pasife alınan ya da aboneliği biten mülkün sayfası kapalı (is_public korunur)", async () => {
    await as(O, wsA, (tx, ctx) => setPropertyStatus(tx, ctx, propA, "passive"));
    let p = await as(O, wsA, (tx) => getPublicProfile(tx, propA));
    expect(p?.visibility).toEqual({ state: "closed", unmet: ["active"] });
    expect(p?.isPublic).toBe(true);
    await as(O, wsA, (tx, ctx) => setPropertyStatus(tx, ctx, propA, "active"));

    await admin.query(
      "update workspace_subscriptions set trial_ends_at = now() - interval '1 day' where workspace_id = $1",
      [wsA],
    );
    p = await as(O, wsA, (tx) => getPublicProfile(tx, propA));
    expect(p?.visibility).toEqual({ state: "closed", unmet: ["subscription"] });
    await admin.query(
      "update workspace_subscriptions set trial_ends_at = now() + interval '14 days' where workspace_id = $1",
      [wsA],
    );
  });

  it("numara kaldırılırsa sayfa kapanır; yeniden eklenince açılır", async () => {
    await as(O, wsA, (tx, ctx) => updateWorkspaceWhatsapp(tx, ctx, ""));
    expect((await as(O, wsA, (tx) => getPublicProfile(tx, propA)))?.visibility).toEqual({
      state: "closed",
      unmet: ["whatsapp"],
    });
    await as(O, wsA, (tx, ctx) => updateWorkspaceWhatsapp(tx, ctx, "+905321234567"));
  });

  it("yayından kaldırma: adres ve ayarlar korunur; staff kaldıramaz", async () => {
    expect((await failure(as(S, wsA, (tx, ctx) => unpublishProperty(tx, ctx, propA)))).code).toBe(
      "FORBIDDEN",
    );
    expect(await as(M, wsA, (tx, ctx) => unpublishProperty(tx, ctx, propA))).toEqual({
      changed: true,
    });
    expect(await as(M, wsA, (tx, ctx) => unpublishProperty(tx, ctx, propA))).toEqual({
      changed: false,
    });
    expect(await rowOf(propA)).toMatchObject({
      is_public: false,
      public_slug: `villa-yeni-${tag}`,
    });
    expect((await auditOf(wsA, "property.unpublished")).length).toBe(1);
    // Taslakta adres silinebilir.
    await as(O, wsA, (tx, ctx) =>
      updatePublicProfile(tx, ctx, propA, profile({ publicSlug: "", checkOutTime: "11:00" })),
    );
    expect((await rowOf(propA)).public_slug).toBeNull();
  });

  it("eşzamanlı iki yayınlama: tek değişiklik, tek denetim kaydı", async () => {
    await as(B, wsB, (tx, ctx) => updateWorkspaceWhatsapp(tx, ctx, "05559876543"));
    await addPhoto(B, wsB, propB);
    const results = await Promise.all([
      as(B, wsB, (tx, ctx) => publishProperty(tx, ctx, propB)),
      as(B, wsB, (tx, ctx) => publishProperty(tx, ctx, propB)),
    ]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect((await auditOf(wsB, "property.published")).length).toBe(1);
  });
});
