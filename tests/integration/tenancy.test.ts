import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import { pgErrorInfo } from "@/db/pg-error";
import * as schema from "@/db/schema";
import { type Tx, withTenant, withUser } from "@/db/tenant";
import { recordAudit } from "@/server/audit/record";
import {
  addWorkspaceMember,
  changeMemberRole,
  createWorkspace,
  listMyWorkspaces,
  listWorkspaceMembers,
  removeWorkspaceMember,
} from "@/server/workspaces/service";

const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 6 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });

/** Drizzle hatayı sarar; asıl PostgreSQL mesajını `.cause` zincirinden çıkarır. */
const pgMessage = (p: Promise<unknown>) =>
  p.then(
    () => "başarılı (hata bekleniyordu)",
    (err: unknown) => pgErrorInfo(err).message ?? String(err),
  );

const tag = randomBytes(3).toString("hex");
const slugOf = (s: string) => `${s}-${tag}`;

type U = { id: string; email: string; name: string };
const mkUser = async (label: string): Promise<U> => {
  const u = { id: uuidv7(), email: `${label}.${tag}@ornek.com`, name: `${label} Kullanıcı` };
  await admin.query("insert into users (id, name, email) values ($1, $2, $3)", [
    u.id,
    u.name,
    u.email,
  ]);
  return u;
};

let A: U, B: U, C: U, M: U, S: U, E: U;
let wsA: string, wsB: string;

beforeAll(async () => {
  await admin.connect();
  [A, B, C, M, S, E] = (await Promise.all(
    ["ayse", "burak", "cem", "mert", "selin", "eda"].map(mkUser),
  )) as [U, U, U, U, U, U];
  wsA = (await createWorkspace(app, { userId: A.id, name: "Ayşe Villaları", slug: slugOf("ayse") }))
    .id;
  wsB = (await createWorkspace(app, { userId: B.id, name: "Burak Evleri", slug: slugOf("burak") }))
    .id;
  await withTenant(app, { userId: A.id, workspaceId: wsA }, async (tx, ctx) => {
    await addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" });
    await addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" });
  });
});

afterAll(async () => {
  await admin.end();
  await appPool.end();
});

const count = async (tx: Parameters<Parameters<typeof withUser>[2]>[0], table: string) =>
  Number((await tx.execute(sql.raw(`select count(*)::int as n from ${table}`))).rows[0]?.n);

/** Bağlamı withTenant'ı atlayarak elle kurar (uygulama hatası / doğrudan SQL senaryosu). */
const asRawContext = <T>(userId: string, workspaceId: string, fn: (tx: Tx) => Promise<T>) =>
  withUser(app, userId, async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    return fn(tx);
  });

/** Admin bağlantısında, verilen backend'in bir kilit beklediği görülene kadar bekler. */
const waitUntilBlocked = async (where: string, params: unknown[]) => {
  for (let i = 0; i < 100; i++) {
    const r = await admin.query(`select 1 from pg_stat_activity where ${where}`, params);
    if (r.rowCount) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("Beklenen kilit beklemesi oluşmadı");
};

describe("workspace oluşturma (atomik)", () => {
  it("workspace + ilk owner + denetim kaydı birlikte oluşur", async () => {
    const ws = await admin.query(
      "select name, slug, status, created_by from workspaces where id = $1",
      [wsA],
    );
    expect(ws.rows[0]).toMatchObject({ slug: slugOf("ayse"), status: "active", created_by: A.id });
    const m = await admin.query(
      "select user_id, role from workspace_members where workspace_id = $1 order by created_at",
      [wsA],
    );
    expect(m.rows[0]).toEqual({ user_id: A.id, role: "owner" });
    const a = await admin.query(
      "select action, actor_user_id, target_id, metadata from audit_log where workspace_id = $1 and action = 'workspace.created'",
      [wsA],
    );
    expect(a.rows).toEqual([
      {
        action: "workspace.created",
        actor_user_id: A.id,
        target_id: wsA,
        metadata: { slug: slugOf("ayse") },
      },
    ]);
  });

  const failOn = async (table: string, fn: () => Promise<unknown>) => {
    const name = `kg_fail_${randomBytes(3).toString("hex")}`;
    await admin.query(
      `create function ${name}() returns trigger language plpgsql as $$ begin raise exception 'test_hatasi'; end $$`,
    );
    await admin.query(
      `create trigger ${name} before insert on ${table} for each row execute function ${name}()`,
    );
    try {
      expect(await pgMessage(fn())).toMatch(/test_hatasi/);
    } finally {
      await admin.query(`drop trigger ${name} on ${table}; drop function ${name}()`);
    }
  };

  it("denetim kaydı yazılamazsa workspace ve üyelik de oluşmaz", async () => {
    const slug = slugOf("rollback-audit");
    await failOn("audit_log", () =>
      createWorkspace(app, { userId: C.id, name: "Geri Alma", slug }),
    );
    expect((await admin.query("select 1 from workspaces where slug = $1", [slug])).rowCount).toBe(
      0,
    );
    expect(
      (await admin.query("select 1 from workspace_members where user_id = $1", [C.id])).rowCount,
    ).toBe(0);
  });

  it("owner üyeliği yazılamazsa workspace oluşmaz", async () => {
    const slug = slugOf("rollback-member");
    await failOn("workspace_members", () =>
      createWorkspace(app, { userId: C.id, name: "Geri Alma", slug }),
    );
    expect((await admin.query("select 1 from workspaces where slug = $1", [slug])).rowCount).toBe(
      0,
    );
  });

  it("alınmış adres CONFLICT verir ve hiçbir şey yazmaz", async () => {
    const before = Number((await admin.query("select count(*) n from audit_log")).rows[0].n);
    await expect(
      createWorkspace(app, { userId: C.id, name: "Kopya", slug: slugOf("ayse") }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(Number((await admin.query("select count(*) n from audit_log")).rows[0].n)).toBe(before);
    expect(
      (await admin.query("select 1 from workspace_members where user_id = $1", [C.id])).rowCount,
    ).toBe(0);
  });

  it("geçersiz veya ayrılmış adres reddedilir", async () => {
    for (const slug of ["admin", "A", "-baslik", "çok-türkçe", "a"]) {
      await expect(
        createWorkspace(app, { userId: C.id, name: "X İşletme", slug }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

  it("başka kullanıcı adına workspace oluşturulamaz (RLS)", async () => {
    const id = uuidv7();
    expect(
      await pgMessage(
        withUser(app, C.id, async (tx) => {
          await tx.execute(sql`select set_config('app.workspace_id', ${id}, true)`);
          await tx.execute(
            sql`insert into workspaces (id, name, slug, created_by) values (${id}, 'Sahte', ${slugOf("sahte")}, ${A.id})`,
          );
        }),
      ),
    ).toMatch(/row-level security/);
  });
});

describe("withTenant: üyelik doğrulama", () => {
  it("üye için rolü döndürür", async () => {
    for (const [u, role] of [
      [A, "owner"],
      [M, "manager"],
      [S, "staff"],
    ] as const) {
      const ctx = await withTenant(app, { userId: u.id, workspaceId: wsA }, async (_tx, c) => c);
      expect(ctx).toEqual({ userId: u.id, workspaceId: wsA, role });
    }
  });

  it("üye olmayan, olmayan workspace ve askıdaki workspace aynı NOT_FOUND hatasını alır", async () => {
    const errs = await Promise.all([
      withTenant(app, { userId: C.id, workspaceId: wsA }, async () => 1).catch((e) => e),
      withTenant(app, { userId: A.id, workspaceId: uuidv7() }, async () => 1).catch((e) => e),
    ]);
    await admin.query("update workspaces set status = 'suspended' where id = $1", [wsB]);
    try {
      errs.push(
        await withTenant(app, { userId: B.id, workspaceId: wsB }, async () => 1).catch((e) => e),
      );
    } finally {
      await admin.query("update workspaces set status = 'active' where id = $1", [wsB]);
    }
    for (const e of errs)
      expect(e).toMatchObject({ code: "NOT_FOUND", message: "İşletme bulunamadı." });
  });

  it("geçersiz kimlikler reddedilir", async () => {
    await expect(
      withTenant(app, { userId: "1 or 1=1", workspaceId: wsA }, async () => 1),
    ).rejects.toThrow(/UUID/);
    await expect(
      withTenant(app, { userId: A.id, workspaceId: "'; drop table x;--" }, async () => 1),
    ).rejects.toThrow(/UUID/);
  });

  it("bağlam ayarları transaction bitince bağlantıda kalmaz", async () => {
    const one = new Pool({ connectionString: db.appUrl, max: 1 });
    const d = drizzle(one, { schema, casing: DB_CASING });
    try {
      await withTenant(d, { userId: A.id, workspaceId: wsA }, async () => 1);
      const r = await one.query(
        "select current_setting('app.user_id', true) u, current_setting('app.workspace_id', true) w",
      );
      expect([r.rows[0].u ?? "", r.rows[0].w ?? ""]).toEqual(["", ""]);
    } finally {
      await one.end();
    }
  });
});

describe("tenant izolasyonu", () => {
  it("B'nin bağlamında yalnız B'nin verisi görünür", async () => {
    await withTenant(app, { userId: B.id, workspaceId: wsB }, async (tx) => {
      const ws = await tx.execute<{ id: string }>(sql`select id from workspaces`);
      expect(ws.rows.map((r) => r.id)).toEqual([wsB]);
      const m = await tx.execute<{ workspace_id: string }>(
        sql`select workspace_id from workspace_members`,
      );
      expect(new Set(m.rows.map((r) => r.workspace_id))).toEqual(new Set([wsB]));
      const a = await tx.execute<{ workspace_id: string }>(sql`select workspace_id from audit_log`);
      expect(new Set(a.rows.map((r) => r.workspace_id))).toEqual(new Set([wsB]));
    });
  });

  it("üye olmayan kullanıcı bağlamı elle kursa bile hiçbir şey göremez ve yazamaz", async () => {
    await withUser(app, C.id, async (tx) => {
      await tx.execute(sql`select set_config('app.workspace_id', ${wsA}, true)`);
      expect([
        await count(tx, "workspaces"),
        await count(tx, "workspace_members"),
        await count(tx, "audit_log"),
      ]).toEqual([0, 0, 0]);
    });
    for (const role of ["owner", "staff"]) {
      expect(
        await pgMessage(
          withUser(app, C.id, async (tx) => {
            await tx.execute(sql`select set_config('app.workspace_id', ${wsA}, true)`);
            await tx.execute(
              sql`insert into workspace_members (id, workspace_id, user_id, role) values (${uuidv7()}, ${wsA}, ${C.id}, ${role})`,
            );
          }),
        ),
      ).toMatch(/row-level security/);
    }
    await expect(
      withUser(app, C.id, async (tx) => {
        await tx.execute(sql`select set_config('app.workspace_id', ${wsA}, true)`);
        return tx.execute(sql`update workspaces set name = 'Ele geçirildi' where id = ${wsA}`);
      }),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it("bir workspace'in bağlamında başka workspace'e yazılamaz", async () => {
    expect(
      await pgMessage(
        withTenant(app, { userId: A.id, workspaceId: wsA }, async (tx) =>
          tx.execute(
            sql`insert into workspace_members (id, workspace_id, user_id, role) values (${uuidv7()}, ${wsB}, ${A.id}, 'owner')`,
          ),
        ),
      ),
    ).toMatch(/row-level security/);
  });

  it("bağlam yokken hiçbir satır görünmez", async () => {
    const r = await appPool.query(
      "select (select count(*) from workspaces)::int w, (select count(*) from workspace_members)::int m, (select count(*) from audit_log)::int a",
    );
    expect(r.rows[0]).toEqual({ w: 0, m: 0, a: 0 });
  });
});

describe("ilk owner istisnası (Y1)", () => {
  it("çıkarılan kurucu kendini yeniden owner yapamaz, workspace'i göremez, üyeleri değiştiremez", async () => {
    const [K, L] = await Promise.all([mkUser("kurucu"), mkUser("ortak")]);
    const ws = await createWorkspace(app, {
      userId: K.id,
      name: "Kurucu Evi",
      slug: slugOf("kurucu"),
    });
    await withTenant(app, { userId: K.id, workspaceId: ws.id }, (tx, ctx) =>
      addWorkspaceMember(tx, ctx, { userId: L.id, role: "owner" }),
    );
    await withTenant(app, { userId: L.id, workspaceId: ws.id }, async (tx, ctx) => {
      const [k] = (await listWorkspaceMembers(tx)).filter((m) => m.name === K.name);
      await removeWorkspaceMember(tx, ctx, k!.memberId);
    });

    await asRawContext(K.id, ws.id, async (tx) => {
      expect(await count(tx, "workspaces")).toBe(0);
      expect(await count(tx, "workspace_members")).toBe(0);
      const r = await tx.execute(
        sql`update workspace_members set role = 'staff' where user_id = ${L.id}`,
      );
      expect(r.rowCount).toBe(0);
    });
    expect(
      await pgMessage(
        asRawContext(K.id, ws.id, (tx) =>
          tx.execute(
            sql`insert into workspace_members (id, workspace_id, user_id, role) values (${uuidv7()}, ${ws.id}, ${K.id}, 'owner')`,
          ),
        ),
      ),
    ).toMatch(/row-level security/);
    const rows = await admin.query(
      "select user_id, role from workspace_members where workspace_id = $1",
      [ws.id],
    );
    expect(rows.rows).toEqual([{ user_id: L.id, role: "owner" }]);
  });
});

describe("askıya alınmış workspace (O1)", () => {
  it("bağlam elle kurulsa bile okuma ve yazma kapalı; rol NULL", async () => {
    const [P, R] = await Promise.all([mkUser("askida"), mkUser("askidapersonel")]);
    const ws = await createWorkspace(app, { userId: P.id, name: "Askı Evi", slug: slugOf("aski") });
    await withTenant(app, { userId: P.id, workspaceId: ws.id }, (tx, ctx) =>
      addWorkspaceMember(tx, ctx, { userId: R.id, role: "staff" }),
    );
    await admin.query("update workspaces set status = 'suspended' where id = $1", [ws.id]);

    await asRawContext(P.id, ws.id, async (tx) => {
      const role = await tx.execute<{ r: string | null }>(
        sql`select app_current_member_role() as r`,
      );
      expect(role.rows[0]?.r).toBeNull();
      expect(await count(tx, "workspaces")).toBe(0);
      expect(await count(tx, "workspace_members")).toBe(0);
      expect(await count(tx, "audit_log")).toBe(0);
      expect(
        (await tx.execute(sql`update workspaces set name = 'Değişti' where id = ${ws.id}`))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await tx.execute(
            sql`update workspace_members set role = 'manager' where user_id = ${R.id}`,
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (await tx.execute(sql`delete from workspace_members where user_id = ${R.id}`)).rowCount,
      ).toBe(0);
    });
    for (const stmt of [
      sql`insert into workspace_members (id, workspace_id, user_id, role) values (${uuidv7()}, ${ws.id}, ${C.id}, 'staff')`,
      sql`insert into audit_log (id, workspace_id, actor_user_id, action) values (${uuidv7()}, ${ws.id}, ${P.id}, 'workspace.updated')`,
    ]) {
      expect(await pgMessage(asRawContext(P.id, ws.id, (tx) => tx.execute(stmt)))).toMatch(
        /row-level security/,
      );
    }
    const after = await admin.query(
      "select (select name from workspaces where id = $1) as name, (select count(*)::int from workspace_members where workspace_id = $1) as members",
      [ws.id],
    );
    expect(after.rows[0]).toEqual({ name: "Askı Evi", members: 2 });
  });
});

describe("üyelik listesi", () => {
  it("bağlam yokken kullanıcı yalnız kendi üyeliklerini görür", async () => {
    await createWorkspace(app, { userId: S.id, name: "Selin Pansiyon", slug: slugOf("selin") });
    const mine = await listMyWorkspaces(app, S.id);
    expect(mine.map((w) => [w.slug, w.role]).sort()).toEqual(
      [
        [slugOf("ayse"), "staff"],
        [slugOf("selin"), "owner"],
      ].sort(),
    );
    await withUser(app, S.id, async (tx) => {
      const rows = await tx.execute<{ user_id: string }>(
        sql`select user_id from workspace_members`,
      );
      expect(new Set(rows.rows.map((r) => r.user_id))).toEqual(new Set([S.id]));
    });
  });

  it("staff aynı workspace'teki üyeleri görür; yalnız ad, rol, tarih — e-posta yok", async () => {
    const list = await withTenant(app, { userId: S.id, workspaceId: wsA }, (tx) =>
      listWorkspaceMembers(tx),
    );
    expect(list.map((m) => [m.name, m.role])).toEqual([
      [A.name, "owner"],
      [M.name, "manager"],
      [S.name, "staff"],
    ]);
    for (const m of list) {
      expect(Object.keys(m).sort()).toEqual(["joinedAt", "memberId", "name", "role"]);
      expect(JSON.stringify(m)).not.toContain("@");
    }
  });

  it("bir workspace'in listesinde başka workspace üyesi yoktur", async () => {
    const list = await withTenant(app, { userId: S.id, workspaceId: wsA }, (tx) =>
      listWorkspaceMembers(tx),
    );
    expect(list.some((m) => m.name === B.name)).toBe(false);
  });
});

describe("rol matrisi", () => {
  it("manager yalnız staff ekleyebilir", async () => {
    await withTenant(app, { userId: M.id, workspaceId: wsA }, async (tx, ctx) => {
      await expect(
        addWorkspaceMember(tx, ctx, { userId: E.id, role: "manager" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
    // Uygulama denetimi atlansa bile RLS engeller.
    expect(
      await pgMessage(
        withTenant(app, { userId: M.id, workspaceId: wsA }, (tx) =>
          tx.execute(
            sql`insert into workspace_members (id, workspace_id, user_id, role) values (${uuidv7()}, ${wsA}, ${E.id}, 'owner')`,
          ),
        ),
      ),
    ).toMatch(/row-level security/);
    const id = await withTenant(app, { userId: M.id, workspaceId: wsA }, (tx, ctx) =>
      addWorkspaceMember(tx, ctx, { userId: E.id, role: "staff" }),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("staff üye ekleyemez, rol değiştiremez, denetim kaydını okuyamaz", async () => {
    await withTenant(app, { userId: S.id, workspaceId: wsA }, async (tx, ctx) => {
      await expect(
        addWorkspaceMember(tx, ctx, { userId: C.id, role: "staff" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await count(tx, "audit_log")).toBe(0);
      const r = await tx.execute(
        sql`update workspace_members set role = 'owner' where user_id = ${S.id}`,
      );
      expect(r.rowCount).toBe(0);
    });
    expect(
      await pgMessage(
        withTenant(app, { userId: S.id, workspaceId: wsA }, (tx) =>
          tx.execute(
            sql`insert into workspace_members (id, workspace_id, user_id, role) values (${uuidv7()}, ${wsA}, ${C.id}, 'staff')`,
          ),
        ),
      ),
    ).toMatch(/row-level security/);
  });

  it("manager denetim kaydını okur, rol değiştiremez ve üye çıkaramaz", async () => {
    await withTenant(app, { userId: M.id, workspaceId: wsA }, async (tx) => {
      expect(await count(tx, "audit_log")).toBeGreaterThan(0);
      expect(
        (await tx.execute(sql`update workspace_members set role = 'staff' where user_id = ${A.id}`))
          .rowCount,
      ).toBe(0);
      expect(
        (await tx.execute(sql`delete from workspace_members where user_id = ${S.id}`)).rowCount,
      ).toBe(0);
    });
  });

  it("owner rol değiştirir; işlem denetim kaydına düşer", async () => {
    await withTenant(app, { userId: A.id, workspaceId: wsA }, async (tx, ctx) => {
      const [sMember] = (await listWorkspaceMembers(tx)).filter((m) => m.name === S.name);
      await changeMemberRole(tx, ctx, { memberId: sMember!.memberId, role: "manager" });
      await changeMemberRole(tx, ctx, { memberId: sMember!.memberId, role: "staff" });
      const a = await tx.execute<{ metadata: unknown }>(
        sql`select metadata from audit_log where target_id = ${sMember!.memberId} and action = 'workspace.member_role_changed' order by occurred_at`,
      );
      expect(a.rows.map((r) => r.metadata)).toEqual([
        { from: "staff", to: "manager" },
        { from: "manager", to: "staff" },
      ]);
    });
  });
});

describe("rol değişikliği tutarlılığı (D2)", () => {
  it("UPDATE tam 1 satırı değiştirmezse CONFLICT verir ve denetim kaydı yazmaz", async () => {
    const [O, T] = await Promise.all([mkUser("d2sahip"), mkUser("d2hedef")]);
    const ws = await createWorkspace(app, { userId: O.id, name: "D2 Evi", slug: slugOf("d2") });
    const memberId = await withTenant(app, { userId: O.id, workspaceId: ws.id }, (tx, ctx) =>
      addWorkspaceMember(tx, ctx, { userId: T.id, role: "staff" }),
    );
    // Yalnız bu üyenin UPDATE'ini sessizce atlayan geçici tetikleyici (0 satır etkilenir).
    const fn = `d2_skip_${tag}`;
    await admin.query(
      `create function ${fn}() returns trigger language plpgsql as $$ begin return null; end $$`,
    );
    await admin.query(
      `create trigger ${fn} before update on workspace_members for each row when (old.id = '${memberId}') execute function ${fn}()`,
    );
    try {
      await expect(
        withTenant(app, { userId: O.id, workspaceId: ws.id }, (tx, ctx) =>
          changeMemberRole(tx, ctx, { memberId, role: "manager" }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await admin.query(`drop trigger ${fn} on workspace_members; drop function ${fn}()`);
    }
    const r = await admin.query(
      "select (select role from workspace_members where id = $1) as role, (select count(*)::int from audit_log where target_id = $1 and action = 'workspace.member_role_changed') as audits",
      [memberId],
    );
    expect(r.rows[0]).toEqual({ role: "staff", audits: 0 });
  });

  it("eşzamanlı iki rol değişikliğinde from/to gerçek değişikliği yansıtır (satır kilidi)", async () => {
    const [O1, O2, T] = await Promise.all([mkUser("d2o1"), mkUser("d2o2"), mkUser("d2t")]);
    const ws = await createWorkspace(app, {
      userId: O1.id,
      name: "D2 Yarış",
      slug: slugOf("d2yaris"),
    });
    const memberId = await withTenant(
      app,
      { userId: O1.id, workspaceId: ws.id },
      async (tx, ctx) => {
        await addWorkspaceMember(tx, ctx, { userId: O2.id, role: "owner" });
        return addWorkspaceMember(tx, ctx, { userId: T.id, role: "staff" });
      },
    );
    const p1 = new Pool({ connectionString: db.appUrl, max: 1 });
    const p2 = new Pool({ connectionString: db.appUrl, max: 1 });
    try {
      const d1 = drizzle(p1, { schema, casing: DB_CASING });
      const d2 = drizzle(p2, { schema, casing: DB_CASING });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let changed!: () => void;
      const t1Changed = new Promise<void>((r) => (changed = r));
      const t1 = withTenant(d1, { userId: O1.id, workspaceId: ws.id }, async (tx, ctx) => {
        await changeMemberRole(tx, ctx, { memberId, role: "manager" });
        changed();
        await gate;
      });
      await t1Changed;
      const t2 = withTenant(d2, { userId: O2.id, workspaceId: ws.id }, (tx, ctx) =>
        changeMemberRole(tx, ctx, { memberId, role: "owner" }),
      );
      try {
        await waitUntilBlocked(
          "datname = current_database() and wait_event_type = 'Lock' and query ilike '%for update%'",
          [],
        );
      } finally {
        release(); // t2 kilitte beklemiyorsa da t1 serbest kalsın; test hızlı başarısız olsun
      }
      await Promise.all([t1, t2]);
    } finally {
      await p1.end();
      await p2.end();
    }
    const a = await admin.query(
      "select metadata from audit_log where target_id = $1 and action = 'workspace.member_role_changed' order by occurred_at, id",
      [memberId],
    );
    expect(a.rows.map((r) => r.metadata)).toEqual([
      { from: "staff", to: "manager" },
      { from: "manager", to: "owner" },
    ]);
  });
});

describe("son owner koruması", () => {
  it("tek owner çıkarılamaz ve rolü düşürülemez", async () => {
    await withTenant(app, { userId: A.id, workspaceId: wsA }, async (tx, ctx) => {
      const [owner] = (await listWorkspaceMembers(tx)).filter((m) => m.role === "owner");
      await expect(removeWorkspaceMember(tx, ctx, owner!.memberId)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(
        changeMemberRole(tx, ctx, { memberId: owner!.memberId, role: "manager" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });
    expect(
      (
        await admin.query(
          "select role from workspace_members where workspace_id = $1 and user_id = $2",
          [wsA, A.id],
        )
      ).rows[0].role,
    ).toBe("owner");
  });

  it("tablo sahibi (migrator) bile son owner'ı silemez", async () => {
    const mig = new Client({ connectionString: db.migratorUrl });
    await mig.connect();
    try {
      // migrator yalnız SELECT politikasına sahip; silme yetkisi olsa bile tetikleyici durdurur.
      await expect(
        mig.query("delete from workspace_members where workspace_id = $1 and role = 'owner'", [
          wsB,
        ]),
      ).resolves.toMatchObject({ rowCount: 0 });
    } finally {
      await mig.end();
    }
    await expect(
      admin.query("delete from workspace_members where workspace_id = $1 and role = 'owner'", [
        wsB,
      ]),
    ).rejects.toThrow(/workspace_last_owner/);
  });

  // Y2: iki owner aynı anda birbirini düşürür/siler; üç izolasyon seviyesinde sıfır owner kalmamalı.
  // READ COMMITTED: ikinci işlem kilidi bekler, sonra son owner hatası alır.
  // SERIALIZABLE: ikinci işlem serialization hatası alır.
  // REPEATABLE READ: owner'ı etkileyen değişiklik baştan reddedilir (fail-closed).
  const ISOLATIONS = ["read committed", "repeatable read", "serializable"] as const;
  const OPS = {
    demote: "update workspace_members set role = 'manager' where id = $1",
    remove: "delete from workspace_members where id = $1",
  } as const;
  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (e: { code?: string }) => e.code ?? "error",
    );

  for (const iso of ISOLATIONS) {
    for (const op of Object.keys(OPS) as (keyof typeof OPS)[]) {
      it(`eşzamanlı ${op} — ${iso}: en az bir owner kalır`, async () => {
        const key = `${iso.replace(" ", "")}${op}`;
        const [u1, u2] = await Promise.all([mkUser(`y2a${key}`), mkUser(`y2b${key}`)]);
        const ws = await createWorkspace(app, {
          userId: u1.id,
          name: "Yarış Evi",
          slug: slugOf(`y2-${op}-${iso.split(" ")[0]}`),
        });
        await withTenant(app, { userId: u1.id, workspaceId: ws.id }, (tx, ctx) =>
          addWorkspaceMember(tx, ctx, { userId: u2.id, role: "owner" }),
        );
        const ids = Object.fromEntries(
          (
            await admin.query("select user_id, id from workspace_members where workspace_id = $1", [
              ws.id,
            ])
          ).rows.map((r) => [r.user_id, r.id]),
        );
        const c1 = new Client({ connectionString: db.appUrl });
        const c2 = new Client({ connectionString: db.appUrl });
        await Promise.all([c1.connect(), c2.connect()]);
        try {
          const begin = async (c: Client, userId: string) => {
            await c.query(`begin isolation level ${iso}`);
            await c.query(
              "select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
              [userId, ws.id],
            );
            await c.query("select count(*) from workspace_members"); // snapshot burada alınır
          };
          await begin(c1, u1.id);
          await begin(c2, u2.id);
          const pid2 = (await c2.query("select pg_backend_pid() as pid")).rows[0].pid;
          const r1 = await outcome(c1.query(OPS[op], [ids[u2.id]]));
          const p2 = outcome(c2.query(OPS[op], [ids[u1.id]]));
          if (r1 === "ok") await waitUntilBlocked("pid = $1 and wait_event_type = 'Lock'", [pid2]);
          const commit1 = await outcome(c1.query(r1 === "ok" ? "commit" : "rollback"));
          const r2 = await p2;
          const commit2 = await outcome(c2.query(r2 === "ok" ? "commit" : "rollback"));
          const owners = (
            await admin.query(
              "select count(*)::int n from workspace_members where workspace_id = $1 and role = 'owner'",
              [ws.id],
            )
          ).rows[0].n;

          const second = r2 === "ok" ? commit2 : r2;
          if (iso === "repeatable read") {
            expect({ r1, r2, owners }).toEqual({ r1: "25000", r2: "25000", owners: 2 });
          } else {
            expect({ r1, commit1, owners }).toEqual({ r1: "ok", commit1: "ok", owners: 1 });
            expect(second).toBe(iso === "read committed" ? "23514" : "40001");
          }
        } finally {
          await Promise.all([c1.end(), c2.end()]);
        }
      });
    }
  }
});

describe("denetim kaydı", () => {
  it("app_user güncelleyemez, silemez, boşaltamaz", async () => {
    expect(
      await pgMessage(
        withTenant(app, { userId: A.id, workspaceId: wsA }, (tx) =>
          tx.execute(sql`update audit_log set action = 'x.y'`),
        ),
      ),
    ).toMatch(/permission denied/);
    for (const stmt of [
      "update audit_log set action = 'x.y'",
      "delete from audit_log",
      "truncate audit_log",
    ]) {
      await expect(appPool.query(stmt), stmt).rejects.toThrow(/permission denied/);
    }
  });

  it("tablo sahibi ve süper kullanıcı bile değiştiremez/silemez", async () => {
    for (const stmt of [
      "update audit_log set action = 'x.y'",
      "delete from audit_log",
      "truncate audit_log",
    ]) {
      await expect(admin.query(stmt), stmt).rejects.toThrow(/audit_log_immutable/);
    }
  });

  it("başkası adına veya zaman damgası belirterek kayıt yazılamaz", async () => {
    expect(
      await pgMessage(
        withTenant(app, { userId: A.id, workspaceId: wsA }, (tx) =>
          tx.execute(
            sql`insert into audit_log (id, workspace_id, actor_user_id, action) values (${uuidv7()}, ${wsA}, ${M.id}, 'workspace.updated')`,
          ),
        ),
      ),
    ).toMatch(/row-level security/);
    expect(
      await pgMessage(
        withTenant(app, { userId: A.id, workspaceId: wsA }, (tx) =>
          tx.execute(
            sql`insert into audit_log (id, workspace_id, actor_user_id, action, occurred_at) values (${uuidv7()}, ${wsA}, ${A.id}, 'workspace.updated', '2000-01-01')`,
          ),
        ),
      ),
    ).toMatch(/permission denied/);
  });

  it("hassas metadata uygulamada reddedilir", async () => {
    await withTenant(app, { userId: A.id, workspaceId: wsA }, async (tx) => {
      await expect(
        // @ts-expect-error bilinçli olarak şemaya aykırı
        recordAudit(tx, { action: "workspace.created", metadata: { slug: "x", email: "a@b.com" } }),
      ).rejects.toThrow(/hassas alan: email/);
    });
  });

  it("kullanıcı silinince kayıt kalır, işlemi yapan NULL olur (KVKK takma adlandırma)", async () => {
    const tmp = await mkUser("gecici");
    await withTenant(app, { userId: A.id, workspaceId: wsA }, (tx, ctx) =>
      addWorkspaceMember(tx, ctx, { userId: tmp.id, role: "staff" }),
    );
    const auditId = await withTenant(app, { userId: tmp.id, workspaceId: wsA }, (tx) =>
      recordAudit(tx, { action: "workspace.updated", metadata: { fields: ["name"] } }),
    );
    await admin.query("delete from users where id = $1", [tmp.id]);
    const r = await admin.query("select actor_user_id, action from audit_log where id = $1", [
      auditId,
    ]);
    expect(r.rows[0]).toEqual({ actor_user_id: null, action: "workspace.updated" });
  });
  it("doğrudan UPDATE ile actor silinemez; tetikleyici içinden de kullanıcı varken silinemez (D1)", async () => {
    const auditId = await withTenant(app, { userId: A.id, workspaceId: wsA }, (tx) =>
      recordAudit(tx, { action: "workspace.updated", metadata: { fields: ["slug"] } }),
    );
    // Süper kullanıcı, doğrudan UPDATE (pg_trigger_depth() = 1).
    await expect(
      admin.query("update audit_log set actor_user_id = null where id = $1", [auditId]),
    ).rejects.toThrow(/audit_log_immutable/);
    // Tetikleyici içinden (pg_trigger_depth() > 1) ama kullanıcı hâlâ var: FK zinciri değil.
    const fn = `d1_probe_${tag}`;
    await admin.query(`create table ${fn} (x int)`);
    await admin.query(
      `create function ${fn}() returns trigger language plpgsql as $$ begin update audit_log set actor_user_id = null where id = '${auditId}'; return new; end $$`,
    );
    await admin.query(
      `create trigger ${fn} after insert on ${fn} for each row execute function ${fn}()`,
    );
    try {
      await expect(admin.query(`insert into ${fn} values (1)`)).rejects.toThrow(
        /audit_log_immutable/,
      );
    } finally {
      await admin.query(`drop table ${fn}; drop function ${fn}()`);
    }
    const r = await admin.query("select actor_user_id from audit_log where id = $1", [auditId]);
    expect(r.rows[0].actor_user_id).toBe(A.id);
  });
});
