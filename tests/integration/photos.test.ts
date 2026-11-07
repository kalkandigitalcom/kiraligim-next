import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import sharp from "sharp";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import { pgErrorInfo } from "@/db/pg-error";
import * as schema from "@/db/schema";
import { type Tx, withTenant, withUser } from "@/db/tenant";
import { createLogger } from "@/lib/logger";
import { createJobQueue } from "@/server/media/queue";
import { createPhotoUploadHandler, type UploadActor } from "@/server/properties/photo-upload";
import {
  deletePhoto,
  insertPhoto,
  listPhotos,
  movePhoto,
  photoPrefix,
  precheckPhotoUpload,
  setCoverPhoto,
} from "@/server/properties/photos";
import { createProperty, listProperties } from "@/server/properties/service";
import { createMemoryStorage } from "@/server/storage/memory";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

/**
 * Aşama 2.4c: mülk fotoğrafları (0011, 0012) — gerçek PostgreSQL, app_user. Depolama bellek
 * sürücüsüyle; görsel işleme gerçek sharp ile.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 8 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });

const tag = randomBytes(3).toString("hex");
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

const propertyInput = {
  name: "Deniz Villa",
  propertyType: "villa",
  maxGuests: "4",
  bedrooms: "2",
  bathrooms: "1",
  bedsDouble: "1",
  bedsSingle: "2",
  bedsSofa: "",
  province: "Antalya",
  district: "Kaş",
};
const mkProperty = (u: U, ws: string) =>
  withTenant(app, { userId: u.id, workspaceId: ws }, (tx, ctx) =>
    createProperty(tx, ctx, propertyInput),
  );

const bytes = { 400: 1000, 1200: 2000, 2000: 3000 } as const;
const newPhoto = (ws: string, property: string) => {
  const id = uuidv7();
  return {
    id,
    propertyId: property,
    storagePrefix: photoPrefix(ws, property, id),
    width: 2000,
    height: 1333,
    quality: 82,
    bytes,
  };
};
const addPhoto = (u: U, ws: string, property: string) =>
  withTenant(app, { userId: u.id, workspaceId: ws }, async (tx, ctx) => {
    const p = newPhoto(ws, property);
    await insertPhoto(tx, ctx, p);
    return p.id;
  });

/** Uygulama denetimini atlayan ham ekleme (yalnız veritabanı kuralları). */
const rawInsert = (tx: Tx, ws: string, property: string) => {
  const id = uuidv7();
  return tx.execute(sql`
    insert into property_photos (id, workspace_id, property_id, created_by, storage_prefix, width,
                                 height, quality, bytes_400, bytes_1200, bytes_2000)
    values (${id}, ${ws}, ${property}, app_current_user_id(), ${photoPrefix(ws, property, id)},
            100, 100, 82, 1, 1, 1)`);
};

const photosOf = async (property: string) =>
  (
    await admin.query(
      "select id, sort_order, is_cover from property_photos where property_id = $1 order by sort_order, id",
      [property],
    )
  ).rows as { id: string; sort_order: number; is_cover: boolean }[];

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
  [O, M, S, B] = (await Promise.all(["foya", "fmert", "fselin", "fbaris"].map(mkUser))) as [
    U,
    U,
    U,
    U,
  ];
  wsA = await mkWorkspace(O, "fa");
  wsB = await mkWorkspace(B, "fb");
  await withTenant(app, { userId: O.id, workspaceId: wsA }, async (tx, ctx) => {
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

describe("ekleme, sıra ve kapak", () => {
  it("ilk fotoğraf kapak olur, sonrakiler sıraya eklenir; istemci değerleri yok sayılır", async () => {
    const a = await addPhoto(O, wsA, propA);
    const b = await addPhoto(M, wsA, propA);
    // Ham eklemede verilen sort_order / is_cover tetikleyicide yeniden hesaplanır.
    await withTenant(app, { userId: O.id, workspaceId: wsA }, async (tx) => {
      const id = uuidv7();
      await tx.execute(sql`
        insert into property_photos (id, workspace_id, property_id, created_by, storage_prefix,
                                     width, height, quality, bytes_400, bytes_1200, bytes_2000,
                                     sort_order, is_cover)
        values (${id}, ${wsA}, ${propA}, app_current_user_id(), ${photoPrefix(wsA, propA, id)},
                10, 10, 82, 1, 1, 1, 999, true)`);
    });
    const rows = await photosOf(propA);
    expect(rows.map((r) => [r.sort_order, r.is_cover])).toEqual([
      [0, true],
      [1, false],
      [2, false],
    ]);
    expect(rows.slice(0, 2).map((r) => r.id)).toEqual([a, b]);
    const audit = await auditOf(wsA, "property.photo_added");
    expect(audit[0]).toEqual({
      actor_user_id: O.id,
      target_type: "property_photo",
      target_id: a,
      metadata: { property: propA },
    });
  });

  it("kapak değiştirilir: her zaman tek kapak", async () => {
    const rows = await photosOf(propA);
    const target = rows[2]!.id;
    await withTenant(app, { userId: M.id, workspaceId: wsA }, async (tx, ctx) => {
      expect(await setCoverPhoto(tx, ctx, propA, target)).toEqual({ changed: true });
      expect(await setCoverPhoto(tx, ctx, propA, target)).toEqual({ changed: false });
    });
    const after = await photosOf(propA);
    expect(after.filter((r) => r.is_cover).map((r) => r.id)).toEqual([target]);
    // Veritabanı: ikinci kapak kısmi benzersiz indeksle reddedilir.
    expect(
      await pgMessage(
        withTenant(app, { userId: O.id, workspaceId: wsA }, (tx) =>
          tx.execute(sql`update property_photos set is_cover = true where property_id = ${propA}`),
        ),
      ),
    ).toMatch(/property_photos_single_cover_idx/);
    expect(await auditOf(wsA, "property.photo_cover_changed")).toHaveLength(1);
  });

  it("sıra değiştirilir (öne / geri al); uçlarda değişiklik olmaz", async () => {
    const before = (await photosOf(propA)).map((r) => r.id);
    await withTenant(app, { userId: O.id, workspaceId: wsA }, async (tx, ctx) => {
      expect(await movePhoto(tx, ctx, propA, before[2]!, "up")).toEqual({ changed: true });
      expect(await movePhoto(tx, ctx, propA, before[0]!, "up")).toEqual({ changed: false });
    });
    const after = await photosOf(propA);
    expect(after.map((r) => r.id)).toEqual([before[0], before[2], before[1]]);
    expect(after.map((r) => r.sort_order)).toEqual([0, 1, 2]);
    await withTenant(app, { userId: O.id, workspaceId: wsA }, async (tx, ctx) => {
      expect(await movePhoto(tx, ctx, propA, before[2]!, "down")).toEqual({ changed: true });
      expect((await listPhotos(tx, propA)).map((p) => p.id)).toEqual(before);
    });
    expect(await auditOf(wsA, "property.photos_reordered")).toHaveLength(2);
  });

  it("kapak silinince sıradaki ilk fotoğraf kapak olur; silme önek döndürür", async () => {
    const rows = await photosOf(propA);
    const cover = rows.find((r) => r.is_cover)!;
    const res = await withTenant(app, { userId: M.id, workspaceId: wsA }, (tx, ctx) =>
      deletePhoto(tx, ctx, propA, cover.id),
    );
    expect(res.storagePrefix).toBe(photoPrefix(wsA, propA, cover.id));
    const after = await photosOf(propA);
    expect(after).toHaveLength(2);
    expect(after.filter((r) => r.is_cover).map((r) => r.id)).toEqual([after[0]!.id]);
    expect(res.newCoverId).toBe(after[0]!.id);
    expect(await auditOf(wsA, "property.photo_removed")).toEqual([
      {
        actor_user_id: M.id,
        target_type: "property_photo",
        target_id: cover.id,
        metadata: { property: propA },
      },
    ]);
    await expect(
      withTenant(app, { userId: M.id, workspaceId: wsA }, (tx, ctx) =>
        deletePhoto(tx, ctx, propA, cover.id),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("mülk listesinde kapak öneki döner", async () => {
    const list = await withTenant(app, { userId: S.id, workspaceId: wsA }, (tx) =>
      listProperties(tx),
    );
    const cover = (await photosOf(propA)).find((r) => r.is_cover)!;
    expect(list.find((p) => p.id === propA)?.coverPrefix).toBe(photoPrefix(wsA, propA, cover.id));
  });
});

describe("roller", () => {
  it("staff görüntüler; ekleyemez, kapak/sıra değiştiremez, silemez (uygulama + veritabanı)", async () => {
    const one = (await photosOf(propA))[1]!.id;
    await withTenant(app, { userId: S.id, workspaceId: wsA }, async (tx, ctx) => {
      expect((await listPhotos(tx, propA)).length).toBeGreaterThan(0);
      await expect(precheckPhotoUpload(tx, ctx, propA)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(insertPhoto(tx, ctx, newPhoto(wsA, propA))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(setCoverPhoto(tx, ctx, propA, one)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(movePhoto(tx, ctx, propA, one, "up")).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(deletePhoto(tx, ctx, propA, one)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
    const n = (await photosOf(propA)).length;
    expect(
      await pgMessage(
        withTenant(app, { userId: S.id, workspaceId: wsA }, (tx) => rawInsert(tx, wsA, propA)),
      ),
    ).toMatch(/row-level security/);
    const upd = await withTenant(app, { userId: S.id, workspaceId: wsA }, (tx) =>
      tx.execute(sql`update property_photos set sort_order = 50 where property_id = ${propA}`),
    );
    expect(upd.rowCount).toBe(0);
    const del = await withTenant(app, { userId: S.id, workspaceId: wsA }, (tx) =>
      tx.execute(sql`delete from property_photos where property_id = ${propA}`),
    );
    expect(del.rowCount).toBe(0);
    expect((await photosOf(propA)).length).toBe(n);
  });

  it("korunan kolonlar değiştirilemez; başkası adına eklenemez", async () => {
    for (const col of ["storage_prefix", "width", "workspace_id", "property_id", "created_by"]) {
      expect(
        await pgMessage(
          withTenant(app, { userId: O.id, workspaceId: wsA }, (tx) =>
            tx.execute(sql.raw(`update property_photos set ${col} = ${col}`)),
          ),
        ),
      ).toMatch(/permission denied/);
    }
    expect(
      await pgMessage(
        withTenant(app, { userId: O.id, workspaceId: wsA }, (tx) => {
          const id = uuidv7();
          return tx.execute(sql`
            insert into property_photos (id, workspace_id, property_id, created_by, storage_prefix,
                                         width, height, quality, bytes_400, bytes_1200, bytes_2000)
            values (${id}, ${wsA}, ${propA}, ${M.id}, ${photoPrefix(wsA, propA, id)},
                    10, 10, 82, 1, 1, 1)`);
        }),
      ),
    ).toMatch(/row-level security/);
  });
});

describe("tenant izolasyonu", () => {
  it("başka işletmenin fotoğrafları görünmez ve değiştirilemez", async () => {
    const bPhoto = await addPhoto(B, wsB, propB);
    await withTenant(app, { userId: O.id, workspaceId: wsA }, async (tx, ctx) => {
      expect(await listPhotos(tx, propB)).toEqual([]);
      await expect(precheckPhotoUpload(tx, ctx, propB)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(setCoverPhoto(tx, ctx, propB, bPhoto)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(movePhoto(tx, ctx, propB, bPhoto, "down")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(deletePhoto(tx, ctx, propB, bPhoto)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      const n = await tx.execute<{ n: number }>(
        sql`select count(*)::int n from property_photos where workspace_id = ${wsB}`,
      );
      expect(n.rows[0]!.n).toBe(0);
    });
    expect((await photosOf(propB)).map((r) => r.id)).toEqual([bPhoto]);
  });

  it("kendi bağlamında başka işletmenin mülküne / işletmesine fotoğraf eklenemez", async () => {
    // Başka işletme kimliğiyle: tetikleyici (mülk görünmez) veya politika reddeder.
    expect(
      await pgMessage(
        withTenant(app, { userId: O.id, workspaceId: wsA }, (tx) => rawInsert(tx, wsB, propB)),
      ),
    ).toMatch(/^property_photo_property_not_found$|row-level security/);
    // Kendi işletme kimliği + başkasının mülkü: bileşik FK reddeder.
    expect(
      await pgMessage(
        withTenant(app, { userId: O.id, workspaceId: wsA }, (tx) => rawInsert(tx, wsA, propB)),
      ),
    ).toMatch(/^property_photo_property_not_found$/);
    // Servis: önek başka işletme/mülk için üretilmişse kabul edilmez.
    await expect(
      withTenant(app, { userId: O.id, workspaceId: wsA }, (tx, ctx) =>
        insertPhoto(tx, ctx, {
          ...newPhoto(wsA, propA),
          storagePrefix: photoPrefix(wsB, propB, uuidv7()),
        }),
      ),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("bağlam elle kurulsa bile üye olmayan göremez; bağlamsız hiçbir şey görünmez", async () => {
    const r = await withUser(app, O.id, async (tx) => {
      await tx.execute(sql`select set_config('app.workspace_id', ${wsB}, true)`);
      return tx.execute(sql`select id from property_photos`);
    });
    expect(r.rows).toEqual([]);
    const none = await withUser(app, O.id, (tx) => tx.execute(sql`select id from property_photos`));
    expect(none.rows).toEqual([]);
  });

  it("askıdaki işletmede okuma ve yazma kapalı", async () => {
    const X = await mkUser("fxena");
    const ws = await mkWorkspace(X, "fx");
    const prop = await mkProperty(X, ws);
    await addPhoto(X, ws, prop);
    await admin.query("update workspaces set status = 'suspended' where id = $1", [ws]);
    await expect(
      withTenant(app, { userId: X.id, workspaceId: ws }, (tx) => listPhotos(tx, prop)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const r = await withUser(app, X.id, async (tx) => {
      await tx.execute(sql`select set_config('app.workspace_id', ${ws}, true)`);
      return tx.execute(sql`select id from property_photos`);
    });
    expect(r.rows).toEqual([]);
  });
});

describe("80 fotoğraf sınırı", () => {
  const fill = async (ws: string, prop: string, count: number) => {
    await admin.query("begin");
    await admin.query("alter table property_photos disable trigger property_photos_before_insert");
    for (let i = 0; i < count; i++) {
      const id = uuidv7();
      await admin.query(
        `insert into property_photos (id, workspace_id, property_id, storage_prefix, width, height,
                                      quality, bytes_400, bytes_1200, bytes_2000, sort_order, is_cover)
         values ($1, $2, $3, $4, 10, 10, 82, 1, 1, 1, $5, $6)`,
        [id, ws, prop, photoPrefix(ws, prop, id), i, i === 0],
      );
    }
    await admin.query("alter table property_photos enable trigger property_photos_before_insert");
    await admin.query("commit");
  };

  it("80'de uygulama ve veritabanı reddeder; silinince yeniden eklenebilir", async () => {
    const L = await mkUser("flale");
    const ws = await mkWorkspace(L, "fl");
    const prop = await mkProperty(L, ws);
    await fill(ws, prop, 79);
    await addPhoto(L, ws, prop); // 80.
    expect((await photosOf(prop)).length).toBe(80);
    await withTenant(app, { userId: L.id, workspaceId: ws }, async (tx, ctx) => {
      await expect(precheckPhotoUpload(tx, ctx, prop)).rejects.toMatchObject({
        code: "LIMIT_REACHED",
        message: "Bu mülk için en fazla 80 fotoğraf yüklenebilir.",
      });
      await expect(insertPhoto(tx, ctx, newPhoto(ws, prop))).rejects.toMatchObject({
        code: "LIMIT_REACHED",
      });
    });
    expect(
      await pgMessage(
        withTenant(app, { userId: L.id, workspaceId: ws }, (tx) => rawInsert(tx, ws, prop)),
      ),
    ).toMatch(/property_photo_limit_reached/);
    expect((await photosOf(prop)).length).toBe(80);
    const last = (await photosOf(prop)).at(-1)!;
    expect(last.sort_order).toBe(79);
    await withTenant(app, { userId: L.id, workspaceId: ws }, (tx, ctx) =>
      deletePhoto(tx, ctx, prop, last.id),
    );
    await addPhoto(L, ws, prop);
    expect((await photosOf(prop)).length).toBe(80);
  });

  it("deneme süresi bitmiş işletme de fotoğraf ekler, düzenler, siler", async () => {
    const T = await mkUser("ftuna");
    const ws = await mkWorkspace(T, "ft");
    const prop = await mkProperty(T, ws);
    await admin.query(
      "update workspace_subscriptions set trial_ends_at = now() - interval '1 minute' where workspace_id = $1",
      [ws],
    );
    const a = await addPhoto(T, ws, prop);
    const b = await addPhoto(T, ws, prop);
    await withTenant(app, { userId: T.id, workspaceId: ws }, async (tx, ctx) => {
      await setCoverPhoto(tx, ctx, prop, b);
      await movePhoto(tx, ctx, prop, b, "up");
      await deletePhoto(tx, ctx, prop, a);
    });
    expect((await photosOf(prop)).map((r) => [r.id, r.is_cover])).toEqual([[b, true]]);
  });

  // İki yönetici aynı anda son (80.) hakkı kullanır; hiçbir seviyede sınır aşılmaz, iki kapak oluşmaz.
  for (const iso of ["read committed", "repeatable read", "serializable"] as const) {
    it(`eşzamanlı ekleme — ${iso}: en fazla 80`, async () => {
      const key = iso.split(" ")[0]!;
      const [u1, u2] = await Promise.all([mkUser(`fe1${key}`), mkUser(`fe2${key}`)]);
      const ws = await mkWorkspace(u1, `fe-${key}`);
      await withTenant(app, { userId: u1.id, workspaceId: ws }, (tx, ctx) =>
        addWorkspaceMember(tx, ctx, { userId: u2.id, role: "manager" }),
      );
      const prop = await mkProperty(u1, ws);
      await fill(ws, prop, 79);
      const c1 = new Client({ connectionString: db.appUrl });
      const c2 = new Client({ connectionString: db.appUrl });
      await Promise.all([c1.connect(), c2.connect()]);
      const ins = (c: Client) => {
        const id = uuidv7();
        return c.query(
          `insert into property_photos (id, workspace_id, property_id, created_by, storage_prefix,
                                        width, height, quality, bytes_400, bytes_1200, bytes_2000)
           values ($1, app_current_workspace_id(), $2, app_current_user_id(), $3, 10, 10, 82, 1, 1, 1)`,
          [id, prop, photoPrefix(ws, prop, id)],
        );
      };
      const outcome = (p: Promise<unknown>) =>
        p.then(
          () => "ok",
          (e: { message?: string }) => e.message ?? "error",
        );
      try {
        for (const [c, u] of [
          [c1, u1],
          [c2, u2],
        ] as const) {
          await c.query(`begin isolation level ${iso}`);
          await c.query(
            "select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
            [u.id, ws],
          );
          await c.query("select count(*) from property_photos");
        }
        const pid2 = (await c2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
        const r1 = await outcome(ins(c1));
        const p2 = outcome(ins(c2));
        if (r1 === "ok") {
          for (let i = 0; i < 100; i++) {
            const w = await admin.query(
              "select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'",
              [pid2],
            );
            if (w.rowCount) break;
            await new Promise((res) => setTimeout(res, 50));
          }
        }
        const commit1 = await outcome(c1.query(r1 === "ok" ? "commit" : "rollback"));
        const r2 = await p2;
        const commit2 = await outcome(c2.query(r2 === "ok" ? "commit" : "rollback"));
        const rows = await photosOf(prop);
        expect(rows.length).toBeLessThanOrEqual(80);
        expect(rows.filter((r) => r.is_cover)).toHaveLength(1);
        if (iso === "repeatable read") {
          expect({ r1, r2, n: rows.length }).toEqual({
            r1: "property_photo_isolation",
            r2: "property_photo_isolation",
            n: 79,
          });
        } else {
          expect({ r1, commit1, n: rows.length }).toEqual({ r1: "ok", commit1: "ok", n: 80 });
          expect(r2 === "ok" ? commit2 : r2).toMatch(
            iso === "read committed" ? /property_photo_limit_reached/ : /could not serialize/,
          );
          expect(new Set(rows.map((r) => r.sort_order)).size).toBe(80);
        }
      } finally {
        await Promise.all([c1.end(), c2.end()]);
      }
    });
  }

  it("negatif kontrol: tetikleyici kapalıyken sınır aşılabilir (testin gerçekten ölçtüğünü doğrular)", async () => {
    const N = await mkUser("fneg");
    const ws = await mkWorkspace(N, "fn");
    const prop = await mkProperty(N, ws);
    await fill(ws, prop, 81);
    expect((await photosOf(prop)).length).toBe(81);
  });

  it("eşzamanlı ilk yüklemeler tek kapak üretir", async () => {
    const K = await mkUser("fkap");
    const ws = await mkWorkspace(K, "fk");
    const prop = await mkProperty(K, ws);
    await Promise.all(Array.from({ length: 6 }, () => addPhoto(K, ws, prop)));
    const rows = await photosOf(prop);
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.is_cover)).toHaveLength(1);
    expect(rows.map((r) => r.sort_order)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("yetkiler, politikalar, fonksiyon, kısıtlar", () => {
  it("RLS ENABLE + FORCE; dört politika yalnız app_user için", async () => {
    const f = await admin.query(
      "select relrowsecurity r, relforcerowsecurity f from pg_class where relname = 'property_photos'",
    );
    expect(f.rows[0]).toEqual({ r: true, f: true });
    const p = await admin.query(
      "select policyname, cmd, roles::text[] as roles from pg_policies where tablename = 'property_photos' order by 1",
    );
    expect(p.rows.map((x) => [x.policyname, x.cmd, x.roles])).toEqual([
      ["property_photos_delete", "DELETE", ["app_user"]],
      ["property_photos_insert", "INSERT", ["app_user"]],
      ["property_photos_select", "SELECT", ["app_user"]],
      ["property_photos_update", "UPDATE", ["app_user"]],
    ]);
  });

  it("tablo/kolon yetkileri: SELECT + DELETE; UPDATE yalnız sort_order ve is_cover", async () => {
    const t = await admin.query(`
      select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as rol, a.privilege_type
        from pg_class c, aclexplode(c.relacl) a
       where c.relname = 'property_photos' and a.grantee <> c.relowner order by 1, 2`);
    expect(t.rows).toEqual([
      { rol: "app_user", privilege_type: "DELETE" },
      { rol: "app_user", privilege_type: "SELECT" },
    ]);
    const cols = await admin.query(`
      select a.attname, x.privilege_type, x.grantee::regrole::text as rol
        from pg_attribute a, aclexplode(a.attacl) x
       where a.attrelid = 'property_photos'::regclass and a.attacl is not null
       order by 2, 1`);
    const byPriv = (p: string) =>
      cols.rows.filter((r) => r.privilege_type === p).map((r) => r.attname as string);
    expect(new Set(cols.rows.map((r) => r.rol))).toEqual(new Set(["app_user"]));
    expect(byPriv("UPDATE")).toEqual(["is_cover", "sort_order"]);
    expect(byPriv("INSERT")).not.toContain("created_at");
  });

  it("tetikleyici: SECURITY INVOKER, sabit search_path, EXECUTE kimsede yok", async () => {
    const r = await admin.query(`
      select prosecdef, pg_get_userbyid(proowner) owner, proconfig, proacl
        from pg_proc where proname = 'app_property_photos_before_insert'`);
    expect(r.rows[0]).toMatchObject({
      prosecdef: false,
      owner: "app_migrator",
      proconfig: ["search_path=pg_catalog, pg_temp"],
    });
    expect(String(r.rows[0].proacl)).toBe("{app_migrator=X/app_migrator}");
  });

  it("CHECK: önek biçimi, boyutlar, kalite ve varyant boyutu (5 MB)", async () => {
    const tryInsert = (over: string) =>
      pgMessage(
        withTenant(app, { userId: O.id, workspaceId: wsA }, (tx) => {
          const id = uuidv7();
          const v: Record<string, unknown> = {
            prefix: photoPrefix(wsA, propA, id),
            width: 100,
            height: 100,
            quality: 82,
            b: 1,
          };
          if (over === "prefix") v.prefix = "../../etc/passwd";
          if (over === "width") v.width = 2001;
          if (over === "quality") v.quality = 95;
          if (over === "bytes") v.b = 5 * 1024 * 1024 + 1;
          return tx.execute(sql`
            insert into property_photos (id, workspace_id, property_id, created_by, storage_prefix,
                                         width, height, quality, bytes_400, bytes_1200, bytes_2000)
            values (${id}, ${wsA}, ${propA}, app_current_user_id(), ${v.prefix}, ${v.width},
                    ${v.height}, ${v.quality}, ${v.b}, 1, 1)`);
        }),
      );
    expect(await tryInsert("prefix")).toMatch(/property_photos_storage_prefix_format/);
    expect(await tryInsert("width")).toMatch(/property_photos_dimensions/);
    expect(await tryInsert("quality")).toMatch(/property_photos_quality_range/);
    expect(await tryInsert("bytes")).toMatch(/property_photos_variant_bytes/);
  });

  it("fotoğrafı olan mülk silinemez (FK restrict); kullanıcı silinince fotoğraf kalır", async () => {
    const U2 = await mkUser("fsil");
    const ws = await mkWorkspace(U2, "fs");
    const prop = await mkProperty(U2, ws);
    const ph = await addPhoto(U2, ws, prop);
    await expect(admin.query("delete from properties where id = $1", [prop])).rejects.toThrow(
      /property_photos_property_fk/,
    );
    const r = await admin.query("select created_by from property_photos where id = $1", [ph]);
    expect(r.rows[0].created_by).toBe(U2.id);
  });
});

describe("yükleme uç noktası (route handler, bellek depolama)", () => {
  const APP_URL = "http://app.localhost:3000";
  const silent = createLogger({ service: "test" }, () => undefined);
  let actor: UploadActor;
  const storage = createMemoryStorage();
  let storageOn = true;
  const handler = createPhotoUploadHandler({
    appUrl: APP_URL,
    db: app,
    getStorage: () => (storageOn ? storage : null),
    resolveActor: async () => actor,
    queue: createJobQueue(1, 3),
    log: silent,
  });
  const req = (
    body: Uint8Array | ReadableStream<Uint8Array> | null,
    headers: Record<string, string> = {},
  ) =>
    new Request(`${APP_URL}/api/mulkler/x/fotograflar`, {
      method: "POST",
      body: body instanceof Uint8Array ? new Uint8Array(body) : body,
      headers: {
        host: "app.localhost:3000",
        origin: APP_URL,
        "content-type": "image/jpeg",
        ...headers,
      },
      // Node fetch: akış gövdesi için gerekli (RequestInit tipinde yok)
      ...{ duplex: "half" },
    });
  let jpeg: Buffer;
  let wsU: string, propU: string, Ou: U, Su: U;

  beforeAll(async () => {
    jpeg = await sharp({
      create: { width: 2400, height: 1600, channels: 3, background: { r: 10, g: 140, b: 160 } },
    })
      .withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "36/1 15/1 30/1" } })
      .jpeg()
      .toBuffer();
    Ou = await mkUser("rou");
    Su = await mkUser("rsu");
    wsU = await mkWorkspace(Ou, "ru");
    await withTenant(app, { userId: Ou.id, workspaceId: wsU }, (tx, ctx) =>
      addWorkspaceMember(tx, ctx, { userId: Su.id, role: "staff" }),
    );
    propU = await mkProperty(Ou, wsU);
    actor = { kind: "ok", userId: Ou.id, workspaceId: wsU };
  });

  const status = async (r: Promise<Response>) => {
    const res = await r;
    return [res.status, ((await res.json()) as { code?: string }).code];
  };

  it("başarılı yükleme: 3 WebP varyantı depolanır, kayıt eklenir, orijinal saklanmaz", async () => {
    const res = await handler(req(jpeg), propU);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      photo: { id: string; isCover: boolean; width: number; sources: { srcSet: string } };
    };
    expect(body.photo.isCover).toBe(true);
    expect(body.photo.width).toBe(2000);
    const prefix = photoPrefix(wsU, propU, body.photo.id);
    expect([...storage.objects.keys()].sort()).toEqual(
      [`${prefix}/1200.webp`, `${prefix}/2000.webp`, `${prefix}/400.webp`].sort(),
    );
    for (const o of storage.objects.values()) {
      expect(o.contentType).toBe("image/webp");
      expect(o.cacheControl).toBe("public, max-age=31536000, immutable");
      expect((await sharp(o.data).metadata()).exif).toBeUndefined();
      expect(Buffer.from(o.data).equals(jpeg)).toBe(false);
    }
    expect(body.photo.sources.srcSet).toContain(`${prefix}/2000.webp 2000w`);
    const row = await admin.query(
      "select bytes_400, bytes_1200, bytes_2000, width, height, created_by from property_photos where id = $1",
      [body.photo.id],
    );
    expect(row.rows[0]).toMatchObject({ width: 2000, height: 1333, created_by: Ou.id });
    expect(row.rows[0].bytes_2000).toBe(storage.objects.get(`${prefix}/2000.webp`)!.data.length);
  });

  it("host, köken ve depolama denetimleri", async () => {
    expect(await status(handler(req(jpeg, { host: "admin.localhost:3000" }), propU))).toEqual([
      404,
      "NOT_FOUND",
    ]);
    expect(await status(handler(req(jpeg, { origin: "https://kotu.example" }), propU))).toEqual([
      403,
      "FORBIDDEN",
    ]);
    const noOrigin = req(jpeg);
    noOrigin.headers.delete("origin");
    expect(await status(handler(noOrigin, propU))).toEqual([403, "FORBIDDEN"]);
    expect(await status(handler(req(jpeg, { "sec-fetch-site": "cross-site" }), propU))).toEqual([
      403,
      "FORBIDDEN",
    ]);
    storageOn = false;
    expect(await status(handler(req(jpeg), propU))).toEqual([503, "STORAGE_UNAVAILABLE"]);
    storageOn = true;
  });

  it("oturum, işletme, rol ve tenant denetimleri", async () => {
    actor = { kind: "unauthenticated" };
    expect(await status(handler(req(jpeg), propU))).toEqual([401, "UNAUTHORIZED"]);
    actor = { kind: "no_workspace" };
    expect(await status(handler(req(jpeg), propU))).toEqual([409, "NO_WORKSPACE"]);
    actor = { kind: "ok", userId: Su.id, workspaceId: wsU };
    expect(await status(handler(req(jpeg), propU))).toEqual([403, "FORBIDDEN"]);
    actor = { kind: "ok", userId: Ou.id, workspaceId: wsU };
    expect(await status(handler(req(jpeg), propB))).toEqual([404, "NOT_FOUND"]);
    expect(await status(handler(req(jpeg), "../../x"))).toEqual([404, "NOT_FOUND"]);
    // Üye olmadığı işletme bağlamı (sahte oturum değeri) → withTenant reddi
    actor = { kind: "ok", userId: Ou.id, workspaceId: wsB };
    expect((await handler(req(jpeg), propB)).status).toBe(404);
    actor = { kind: "ok", userId: Ou.id, workspaceId: wsU };
  });

  it("boyut ve biçim: 15 MB üstü 413 (bildirilen ve akış), yanlış tür 415, sahte dosya 422", async () => {
    const before = storage.objects.size;
    expect(
      await status(handler(req(jpeg, { "content-length": String(16 * 1024 * 1024) }), propU)),
    ).toEqual([413, "TOO_LARGE"]);
    // Content-Length olmadan akış: sınırda kesilir.
    const big = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 16; i++) c.enqueue(new Uint8Array(1024 * 1024));
        c.close();
      },
    });
    expect(await status(handler(req(big), propU))).toEqual([413, "TOO_LARGE"]);
    expect(await status(handler(req(jpeg, { "content-type": "image/gif" }), propU))).toEqual([
      415,
      "UNSUPPORTED_FORMAT",
    ]);
    expect(await status(handler(req(Buffer.from("<?php system($_GET[1]); ?>")), propU))).toEqual([
      422,
      "IMAGE_REJECTED",
    ]);
    expect(await status(handler(req(new Uint8Array()), propU))).toEqual([400, "EMPTY"]);
    expect(storage.objects.size).toBe(before);
  });

  it("depolama hatasında yüklenen varyantlar geri alınır ve kayıt eklenmez", async () => {
    const before = storage.objects.size;
    const rowsBefore = (await photosOf(propU)).length;
    storage.failNextPut(1); // ilk varyant yazılır, ikincisi hata verir
    expect(await status(handler(req(jpeg), propU))).toEqual([502, "STORAGE_FAILED"]);
    expect(storage.objects.size).toBe(before);
    expect((await photosOf(propU)).length).toBe(rowsBefore);
  });

  it("kuyruk doluysa 503 + Retry-After", async () => {
    const busyQueue = createJobQueue(1, 0);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = createPhotoUploadHandler({
      appUrl: APP_URL,
      db: app,
      getStorage: () => storage,
      resolveActor: async () => actor,
      queue: busyQueue,
      log: silent,
    });
    const blocker = busyQueue.run(() => gate);
    const res = await h(req(jpeg), propU);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    release();
    await blocker;
  });

  it("80 sınırı doluyken 402 LIMIT_REACHED; görsel işlenmez", async () => {
    const before = storage.objects.size;
    const existing = (await photosOf(propU)).length;
    await admin.query("begin");
    await admin.query("alter table property_photos disable trigger property_photos_before_insert");
    for (let i = existing; i < 80; i++) {
      const id = uuidv7();
      await admin.query(
        `insert into property_photos (id, workspace_id, property_id, storage_prefix, width, height,
                                      quality, bytes_400, bytes_1200, bytes_2000, sort_order)
         values ($1, $2, $3, $4, 10, 10, 82, 1, 1, 1, $5)`,
        [id, wsU, propU, photoPrefix(wsU, propU, id), i],
      );
    }
    await admin.query("alter table property_photos enable trigger property_photos_before_insert");
    await admin.query("commit");
    let processed = 0;
    const h = createPhotoUploadHandler({
      appUrl: APP_URL,
      db: app,
      getStorage: () => storage,
      resolveActor: async () => actor,
      queue: createJobQueue(1, 3),
      process: async () => {
        processed++;
        throw new Error("çağrılmamalı");
      },
      log: silent,
    });
    expect(await status(h(req(jpeg), propU))).toEqual([402, "LIMIT_REACHED"]);
    expect(processed).toBe(0);
    expect(storage.objects.size).toBe(before);
  });
});
