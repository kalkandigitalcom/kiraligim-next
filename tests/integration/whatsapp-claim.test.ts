import { createHash, randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import { pgErrorInfo } from "@/db/pg-error";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { verifyMessage, parseVerifyMessage } from "@/lib/whatsapp-meta";
import { createProperty } from "@/server/properties/service";
import {
  createPhoneChallenge,
  getConnectionStatus,
  getMyPhone,
  getPhoneChallengeState,
  listGroups,
  listPropertyOptions,
  removeMyPhone,
} from "@/server/whatsapp/service";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

/**
 * WhatsApp Asistanı A1.1 — kodsuz grup eşleştirme (drizzle/0033, 0034). Gerçek PostgreSQL,
 * app_user, FORCE RLS. Ağ geçidi bağlamsız app_user olarak app_wa_* fonksiyonlarını çağırır
 * (burada doğrudan SQL ile taklit edilir); panel withTenant ile servis fonksiyonlarını kullanır.
 *
 * Aşama 2: grup eşleştirme YALNIZ Super Admin'dedir (drizzle/0044; tests/integration/
 * admin-wa-groups.test.ts). İşletme rolü keşfedilen grupları göremez, eski eşleştirme
 * fonksiyonlarını çağıramaz ve wa_groups'u güncelleyemez. Numara doğrulama korunur.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 6 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");

type U = { id: string; email: string };
const mkUser = async (label: string): Promise<U> => {
  const u = { id: uuidv7(), email: `${label}.${tag}@ornek.com` };
  await admin.query(
    "insert into users (id, name, email, email_verified) values ($1, $2, $3, true)",
    [u.id, `${label} K`, u.email],
  );
  return u;
};
const as = <R>(u: U, ws: string, fn: (tx: Tx, ctx: TenantContext) => Promise<R>) =>
  withTenant(app, { userId: u.id, workspaceId: ws }, fn);

/** Ağ geçidi: bağlamsız app_user. */
const gw = async <T>(text: string, values: unknown[]): Promise<T> =>
  (await appPool.query<{ out: T }>(text, values)).rows[0]!.out;

const PN_O = "905321110001"; // işletme sahibi
const PN_X = "905321110003"; // başka işletmenin sahibi
const PN_STRANGER = "905321110009";
const ACCOUNT = "905350000000"; // Kiraligim asistan numarası

let conn = "";
const jidSeq = BigInt(`0x${randomBytes(4).toString("hex")}`) % 10_000_000n;
let jidN = 0;
const newJid = () =>
  `120363${String(jidSeq).padStart(7, "0")}${String(++jidN).padStart(5, "0")}@g.us`;

/** Ağ geçidi grup keşfi (9 parametreli): ekleyen ve kurucu numaralarıyla. */
const sync = (
  jid: string,
  addedBy: string | null,
  owner: string | null = null,
  subject = "Villa Defne Ekibi",
  present = true,
) =>
  gw<string>("select public.app_wa_sync_group($1, $2, $3, 7, false, false, $4, $5, $6) as out", [
    conn,
    jid,
    subject,
    present,
    addedBy,
    owner,
  ]);
const sync7 = (jid: string, subject = "Villa Defne Ekibi") =>
  gw<string>("select public.app_wa_sync_group($1, $2, $3, 7, false, false, true) as out", [
    conn,
    jid,
    subject,
  ]);
const verify = (code: string, pn: string | null) =>
  gw<string>("select public.app_wa_verify_phone($1, $2) as out", [code, pn]);
let msgN = 0;
const ingest = (jid: string) =>
  gw<string>(
    "select public.app_wa_ingest_message($1, $2, $3, '1@lid', $4, null, 'Villa dolu', now(), 'live') as out",
    [conn, jid, `C${tag}${++msgN}`, PN_O],
  );

/** Panelde kod üret → kullanıcı asistana özel mesaj gönderir → ağ geçidi doğrular. */
async function verifyPhoneOf(u: U, w: string, pn: string) {
  const issued = await as(u, w, (tx, ctx) => createPhoneChallenge(tx, ctx));
  const code = parseVerifyMessage(verifyMessage(issued.code));
  expect(code).toBe(issued.code);
  expect(await verify(code!, pn)).toBe("verified");
  return issued;
}

const groupId = async (jid: string) =>
  (await admin.query("select id from wa_groups where jid = $1", [jid])).rows[0].id as string;
const groupRow = async (jid: string) =>
  (
    await admin.query(
      "select status, workspace_id, property_id, added_by_hash, owner_hash from wa_groups where jid = $1",
      [jid],
    )
  ).rows[0];
const phoneHash = (pn: string) => createHash("sha256").update(`wa-phone:${pn}`).digest("hex");

let O: U, M: U, S: U, X: U, N: U;
let ws: string, wsX: string;
let villaA: string, villaB: string, villaX: string;
const planCode = `wa_claim_${tag}`;

async function villa(owner: U, w: string, name: string) {
  return as(owner, w, (tx, ctx) =>
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
}

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("clowner");
  M = await mkUser("clmanager");
  S = await mkUser("clstaff");
  X = await mkUser("clother");
  N = await mkUser("clnewcomer");
  ws = (await createWorkspace(app, { userId: O.id, name: "Eşleştirme", slug: `cl-${tag}` })).id;
  wsX = (await createWorkspace(app, { userId: X.id, name: "Başka", slug: `clx-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'WA test', 20, 14, true, false)",
    [planId, planCode],
  );
  await admin.query("update workspace_subscriptions set plan_id = $1 where workspace_id = $2", [
    planId,
    ws,
  ]);
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
  villaA = await villa(O, ws, "Villa Defne");
  villaB = await villa(O, ws, "Villa Lavanta");
  villaX = await villa(X, wsX, "Başka Villa");
  conn = await gw<string>("select public.app_wa_heartbeat($1, 'open', null, $2) as out", [
    `cl-${tag}`,
    ACCOUNT,
  ]);
});

afterAll(async () => {
  await admin.query(
    "update workspace_subscriptions set plan_id = (select id from plans where is_default) where workspace_id = $1",
    [ws],
  );
  await admin.query("delete from plans where code = $1", [planCode]);
  await admin.end();
  await appPool.end();
});

describe("asistan numarası (kalp atışı)", () => {
  it("4 parametreli kalp atışı numarayı kaydeder; panel wa.me için okur; geçersiz numara reddedilir", async () => {
    const st = await as(S, ws, (tx) => getConnectionStatus(tx));
    expect(st.status).toBe("open");
    const row = await admin.query("select account_pn from wa_connections where id = $1", [conn]);
    expect(row.rows[0].account_pn).toBe(ACCOUNT);
    // 3 parametreli (eski ağ geçidi) çağrı numarayı silmez.
    await gw("select public.app_wa_heartbeat($1, 'open', null) as out", [`cl-${tag}`]);
    expect(
      (await admin.query("select account_pn from wa_connections where id = $1", [conn])).rows[0]
        .account_pn,
    ).toBe(ACCOUNT);
    await expect(
      appPool.query("select public.app_wa_heartbeat($1, 'open', null, 'abc')", [`cl-${tag}`]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("numara doğrulama (asistana özel mesaj, bir kez)", () => {
  it("yalnız owner ve yetkili manager kod üretir; staff ve yetkisiz manager üretemez", async () => {
    await expect(as(S, ws, (tx, ctx) => createPhoneChallenge(tx, ctx))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(as(M, ws, (tx, ctx) => createPhoneChallenge(tx, ctx))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // Politika da reddeder (uygulama denetimi atlanırsa).
    const err = await as(M, ws, (tx) =>
      tx.execute(sql`
        insert into wa_phone_challenges (id, user_id, workspace_id, code_salt, code_hash, expires_at)
        values (${uuidv7()}, app_current_user_id(), app_current_workspace_id(), ${"a".repeat(32)},
                ${"b".repeat(64)}, now() + interval '5 minutes')`),
    ).catch((e: unknown) => e);
    expect(pgErrorInfo(err).code).toBe("42501");
  });

  it("kod düz metin saklanmaz; yanlış kod ve bilinmeyen gönderen doğrulamaz; kod tek kullanımlık", async () => {
    const issued = await as(O, ws, (tx, ctx) => createPhoneChallenge(tx, ctx));
    const row = (
      await admin.query("select code_salt, code_hash from wa_phone_challenges where id = $1", [
        issued.id,
      ])
    ).rows[0];
    expect(JSON.stringify(row)).not.toContain(issued.code);
    expect(row.code_hash).toBe(
      createHash("sha256").update(`${row.code_salt}:${issued.code}`).digest("hex"),
    );
    const wrong = issued.code === "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA";
    expect(await verify(wrong, PN_O)).toBe("invalid");
    expect(await verify(issued.code, null)).toBe("sender_unknown");
    expect(await as(O, ws, (tx) => getMyPhone(tx))).toBeNull();
    expect(await verify(issued.code, PN_O)).toBe("verified");
    expect(await verify(issued.code, PN_O)).toBe("invalid");
    await expect(as(O, ws, (tx) => getPhoneChallengeState(tx, issued.id))).resolves.toEqual({
      state: "used",
      masked: "+90 532 *** ** 01",
    });
    // Kodu yalnız üreten kişi görür.
    await expect(as(M, ws, (tx) => getPhoneChallengeState(tx, issued.id))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const mine = await as(O, ws, (tx) => getMyPhone(tx));
    expect(mine?.masked).toBe("+90 532 *** ** 01");
    // Numara yalnız özet olarak saklanır; app_user özeti okuyamaz.
    const stored = (
      await admin.query(
        "select phone_hash, phone_masked from wa_verified_phones where user_id = $1",
        [O.id],
      )
    ).rows[0];
    expect(stored.phone_hash).toBe(phoneHash(PN_O));
    expect(JSON.stringify(stored)).not.toContain(PN_O);
    const denied = await as(O, ws, (tx) =>
      tx.execute(sql`select phone_hash from wa_verified_phones`),
    ).catch((e: unknown) => e);
    expect(pgErrorInfo(denied).code).toBe("42501");
    const audit = await admin.query(
      "select workspace_id, actor_user_id from audit_log where action = 'whatsapp.phone_verified' and target_id = $1",
      [O.id],
    );
    expect(audit.rows).toEqual([{ workspace_id: ws, actor_user_id: O.id }]);
  });

  it("süresi dolan kod geçersiz", async () => {
    const issued = await as(O, ws, (tx, ctx) => createPhoneChallenge(tx, ctx));
    await admin.query(
      "update wa_phone_challenges set created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes' where id = $1",
      [issued.id],
    );
    expect(await verify(issued.code, PN_STRANGER)).toBe("invalid");
    await expect(as(O, ws, (tx) => getPhoneChallengeState(tx, issued.id))).resolves.toEqual({
      state: "expired",
    });
  });

  it("başka kullanıcılar kendi numaralarını doğrular; başkasının numara kaydı görünmez", async () => {
    await verifyPhoneOf(X, wsX, PN_X);
    expect((await as(X, wsX, (tx) => getMyPhone(tx)))?.masked).toBe("+90 532 *** ** 03");
    const xSeesO = await as(X, wsX, (tx) =>
      tx.execute(sql`select user_id from wa_verified_phones where user_id = ${O.id}`),
    );
    expect(xSeesO.rows).toEqual([]);
  });
});

describe("keşfedilen gruplar (Aşama 2: eşleştirme yalnız Super Admin)", () => {
  let jidO = "";
  let jidOwner = "";

  /** app_user (işletme bağlamında) için beklenen yetki hatası. */
  const denied = async (u: U, w: string, q: ReturnType<typeof sql>) =>
    pgErrorInfo(await as(u, w, (tx) => tx.execute(q)).catch((e: unknown) => e)).code;

  beforeAll(async () => {
    jidO = newJid();
    jidOwner = newJid();
    expect(await sync(jidO, PN_O, PN_STRANGER, "Defne Operasyon")).toBe("discovered");
    expect(await sync(jidOwner, null, PN_O, "Kurduğum Grup")).toBe("discovered");
  });

  it("keşif grubu aktif yapmaz: hiçbir işletmeye bağlı değil, mesajı kaydedilmez", async () => {
    expect(await groupRow(jidO)).toMatchObject({
      status: "discovered",
      workspace_id: null,
      property_id: null,
      added_by_hash: phoneHash(PN_O),
      owner_hash: phoneHash(PN_STRANGER),
    });
    expect(await ingest(jidO)).toBe("ignored");
    expect(await as(O, ws, (tx, ctx) => listGroups(tx, ctx))).toEqual([]);
  });

  it("app_user grupları ve numara özetlerini doğrudan okuyamaz", async () => {
    expect(await denied(O, ws, sql`select added_by_hash from wa_groups`)).toBe("42501");
    const rows = await as(O, ws, (tx) => tx.execute(sql`select id from wa_groups`));
    expect(rows.rows).toEqual([]); // keşfedilen gruplar RLS'te görünmez
  });

  it("ekleyen bilgisi sonradan gelen toplu listede (ekleyensiz) silinmez", async () => {
    await sync7(jidO, "Defne Operasyon");
    await sync(jidO, null, null, "Defne Operasyon");
    expect((await groupRow(jidO)).added_by_hash).toBe(phoneHash(PN_O));
  });

  it("işletme rolü eski eşleştirme fonksiyonlarını çağıramaz (sahip dahil; numara doğrulanmış olsa da)", async () => {
    expect(await as(O, ws, (tx) => getMyPhone(tx))).not.toBeNull();
    const id = await groupId(jidO);
    for (const q of [
      sql`select * from public.app_wa_pending_groups()`,
      sql`select public.app_wa_claim_group(${id}::uuid, ${villaA}::uuid)`,
      sql`select public.app_wa_unlink_group(${id}::uuid)`,
    ]) {
      expect(await denied(O, ws, q)).toBe("42501");
    }
    // Bağlamsız app_user (ağ geçidi parolasıyla) de çağıramaz.
    await expect(
      appPool.query("select public.app_wa_claim_group($1, $2)", [id, villaA]),
    ).rejects.toMatchObject({ code: "42501" });
    expect((await groupRow(jidO)).status).toBe("discovered");
  });

  it("işletme rolü wa_groups'u güncelleyemez/kilitleyemez; yönetici yetkisi ekleyemez", async () => {
    expect(await denied(O, ws, sql`update wa_groups set status = 'suspended'`)).toBe("42501");
    expect(await denied(O, ws, sql`update wa_groups set property_id = ${villaB}`)).toBe("42501");
    expect(await denied(O, ws, sql`select id from wa_groups for update`)).toBe("42501");
    expect(
      await denied(
        O,
        ws,
        sql`insert into wa_link_managers (workspace_id, user_id, granted_by)
            values (app_current_workspace_id(), ${M.id}, app_current_user_id())`,
      ),
    ).toBe("42501");
    expect(await denied(O, ws, sql`delete from wa_link_managers`)).toBe("42501");
    expect((await groupRow(jidOwner)).status).toBe("discovered");
  });

  it("villa seçenekleri (öneri düzenleme) yalnız kendi villaları", async () => {
    expect((await as(O, ws, (tx) => listPropertyOptions(tx))).map((p) => p.id).sort()).toEqual(
      [villaA, villaB].sort(),
    );
    expect((await as(X, wsX, (tx) => listPropertyOptions(tx))).map((p) => p.id)).toEqual([villaX]);
  });

  it("numarasını kaldıran kullanıcı yeniden doğrulayabilir", async () => {
    expect((await as(O, ws, (tx, ctx) => removeMyPhone(tx, ctx))).changed).toBe(true);
    expect(await as(O, ws, (tx) => getMyPhone(tx))).toBeNull();
    await verifyPhoneOf(O, ws, PN_O);
    // Yeni gelen kullanıcı (N) hiçbir grup görmez.
    const wsN = (await createWorkspace(app, { userId: N.id, name: "Yeni", slug: `cln-${tag}` })).id;
    expect(await as(N, wsN, (tx, ctx) => listGroups(tx, ctx))).toEqual([]);
  });
});

describe("ağ geçidi rolü açısından", () => {
  it("ağ geçidi doğrulama ve keşif girdilerini denetler", async () => {
    for (const q of [
      ["select public.app_wa_verify_phone('abc', null)", []],
      ["select public.app_wa_verify_phone('ABCDEFGH', '+90 532')", []],
      [
        "select public.app_wa_sync_group($1, $2, 'x', 1, false, false, true, 'abc', null)",
        [conn, newJid()],
      ],
    ] as const) {
      await expect(appPool.query(q[0], [...q[1]])).rejects.toMatchObject({ code: "23514" });
    }
  });
});
