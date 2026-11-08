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
import { photoPrefix } from "@/server/properties/photos";
import { publishProperty, updatePublicProfile } from "@/server/properties/public-profile";
import { createProperty } from "@/server/properties/service";
import { getVillaPreview } from "@/server/public/preview";
import { getPublicVilla, PUBLIC_VILLA_KEYS } from "@/server/public/villa";
import { createMemoryStorage } from "@/server/storage/memory";
import { updateWorkspaceWhatsapp } from "@/server/workspaces/contact";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

/**
 * Aşama F2d: panel önizlemesi (getVillaPreview) — gerçek PostgreSQL. Yetki sunucuda (owner/manager),
 * veri RLS ile yalnız aktif işletmeden, public sayfayla aynı alanlar, salt okunur.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 4 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const storage = createMemoryStorage("https://img.test.invalid");
const tag = randomBytes(3).toString("hex");
const T = istanbulToday();
const d = (n: number) => addDays(T, n);

const SECRETS = {
  guestName: `Önizleme Misafir ${tag}`,
  guestPhone: "+905001112233",
  note: `Önizleme notu ${tag}`,
  address: `Önizleme Sokak 9 ${tag}`,
  postal: "07960",
  lat: "36.1111",
  lng: "29.2222",
  license: `07-ON-${tag}`,
  workspaceName: `Önizleme İşletme ${tag}`,
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
const preview = (u: U, ws: string, prop: string) =>
  as(u, ws, (tx, ctx) => getVillaPreview(tx, ctx, prop, storage, T));

let O: U, M: U, S: U, X: U;
let ws: string, wsX: string, prop: string, propX: string;
const slug = `onizleme-${tag}`;

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("onowner");
  M = await mkUser("onmanager");
  S = await mkUser("onstaff");
  X = await mkUser("onother");
  ws = (
    await createWorkspace(app, { userId: O.id, name: SECRETS.workspaceName, slug: `on-${tag}` })
  ).id;
  wsX = (await createWorkspace(app, { userId: X.id, name: "Başka", slug: `onx-${tag}` })).id;
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
  const mk = (u: U, w: string, name: string) =>
    as(u, w, (tx, ctx) =>
      createProperty(tx, ctx, {
        name,
        propertyType: "villa",
        maxGuests: "6",
        bedrooms: "3",
        bathrooms: "2",
        province: "Antalya",
        district: "Kaş",
        neighborhood: "Kalkan",
        addressLine: SECRETS.address,
        postalCode: SECRETS.postal,
        latitude: SECRETS.lat,
        longitude: SECRETS.lng,
        tourismLicenseNo: SECRETS.license,
        description: "<p>Taslak açıklama.</p>",
      }),
    );
  prop = await mk(O, ws, "Taslak Villa");
  propX = await mk(X, wsX, "Başka Villa");
  await admin.query(
    `insert into property_rates (id, workspace_id, property_id, start_date, end_date, nightly_amount_minor,
       currency, min_nights, cleaning_fee_minor, created_by)
     values ($1,$2,$3,$4,$5,500000,'TRY',2,150000,$6)`,
    [uuidv7(), ws, prop, d(0), d(60), O.id],
  );
  await admin.query(
    `insert into reservations (id, workspace_id, property_id, kind, status, source, check_in, check_out,
       guest_name, guest_phone, adults, children, total_amount_minor, currency, note, created_by)
     values ($1,$2,$3,'reservation','pending','direct',$4,$5,$6,$7,2,0,1234500,'TRY',$8,$9)`,
    [uuidv7(), ws, prop, d(5), d(8), SECRETS.guestName, SECRETS.guestPhone, SECRETS.note, O.id],
  );
  await admin.query(
    `insert into reservations (id, workspace_id, property_id, kind, status, check_in, check_out, note, created_by)
     values ($1,$2,$3,'block','confirmed',$4,$5,$6,$7)`,
    [uuidv7(), ws, prop, d(8), d(10), SECRETS.note, O.id],
  );
});

afterAll(async () => {
  await admin.end();
  await appPool.end();
});

describe("panel önizlemesi: yetki", () => {
  it("owner taslak villayı görür; adres, fotoğraf, WhatsApp eksik olarak listelenir", async () => {
    const r = await preview(O, ws, prop);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.visibility).toEqual({ state: "draft", unmet: ["slug", "photo", "whatsapp"] });
    expect(r.publicSlug).toBeNull();
    expect(r.hasWhatsapp).toBe(false);
    expect(r.villa.name).toBe("Taslak Villa");
    expect(r.villa.photos).toEqual([]);
    // Bekleyen + blok birleşik tek aralık; ad/durum yok.
    expect(r.villa.busy).toEqual([{ start: d(5), end: d(10) }]);
    expect(r.villa.rates.map((x) => [x.startDate, x.endDate, x.nightlyAmountMinor])).toEqual([
      [d(0), d(60), 500000],
    ]);
  });

  it("manager görür; staff 'forbidden'; başka işletmenin mülkü ve geçersiz kimlik 'not_found'", async () => {
    expect((await preview(M, ws, prop)).kind).toBe("ok");
    expect(await preview(S, ws, prop)).toEqual({ kind: "forbidden" });
    // Başka işletmenin sahibi, kendi işletme bağlamında bu mülkü göremez (RLS).
    expect(await preview(X, wsX, prop)).toEqual({ kind: "not_found" });
    // Kendi işletmesinde başka işletmenin mülk kimliği de bulunamaz.
    expect(await preview(O, ws, propX)).toEqual({ kind: "not_found" });
    expect(await preview(O, ws, "a")).toEqual({ kind: "not_found" });
    expect(await preview(O, ws, uuidv7())).toEqual({ kind: "not_found" });
  });

  it("üye olmayan kullanıcı işletme bağlamı alamaz (withTenant reddeder)", async () => {
    const code = await preview(X, ws, prop).then(
      () => "ok",
      (e: unknown) => (e as { code?: string }).code,
    );
    expect(code).toBe("NOT_FOUND");
  });
});

describe("panel önizlemesi: veri ve güvenlik", () => {
  it("yalnız public anahtarlar; tam adres, koordinat, belge no, işletme adı, misafir bilgisi yok", async () => {
    const r = await preview(O, ws, prop);
    if (r.kind !== "ok") throw new Error("ok bekleniyordu");
    expect(Object.keys(r.villa).sort()).toEqual([...PUBLIC_VILLA_KEYS].sort());
    const json = JSON.stringify(r);
    for (const [k, secret] of Object.entries(SECRETS)) expect(json, k).not.toContain(secret);
    expect(json).not.toContain("12345"); // rezervasyon tutarı
    expect(json).not.toContain(`on-${tag}`); // işletme kısa adresi
  });

  it("transaction salt okunur: önizlemeden sonra aynı transaction'da yazma reddedilir", async () => {
    const code = await as(O, ws, async (tx, ctx) => {
      await getVillaPreview(tx, ctx, prop, storage, T);
      return tx.execute(sql`update properties set name = name where id = ${prop}`);
    }).then(
      () => "ok",
      (e: unknown) => pgErrorInfo(e).code,
    );
    expect(code).toBe("25006");
  });

  it("taslak villa public adreste görünmez; yayınlanınca önizleme ve public sayfa birebir aynı", async () => {
    await as(O, ws, (tx, ctx) =>
      updatePublicProfile(tx, ctx, prop, {
        publicSlug: slug,
        amenities: ["wifi"],
        checkInTime: "15:00",
        checkOutTime: "11:00",
        houseRules: "",
        cancellationPolicy: "",
        paymentTerms: "",
      }),
    );
    expect(await getPublicVilla(app, storage, slug, T)).toBeNull();
    const draft = await preview(O, ws, prop);
    expect(draft.kind === "ok" && draft.visibility.state).toBe("draft");

    const photo = uuidv7();
    await admin.query(
      `insert into property_photos (id, workspace_id, property_id, created_by, storage_prefix, width, height,
         quality, bytes_400, bytes_1200, bytes_2000, is_cover)
       values ($1,$2,$3,$4,$5,1800,1200,82,1,1,1,true)`,
      [photo, ws, prop, O.id, photoPrefix(ws, prop, photo)],
    );
    await as(O, ws, (tx, ctx) => updateWorkspaceWhatsapp(tx, ctx, "0532 765 43 21"));
    // Hâlâ taslak (yayınlanmadı) → public 404
    expect(await getPublicVilla(app, storage, slug, T)).toBeNull();

    await as(O, ws, (tx, ctx) => publishProperty(tx, ctx, prop));
    const pub = await getPublicVilla(app, storage, slug, T);
    const prev = await preview(O, ws, prop);
    expect(pub).not.toBeNull();
    expect(prev.kind === "ok" && prev.visibility).toEqual({ state: "published" });
    expect(prev.kind === "ok" && prev.villa).toEqual(pub);
  });
});
