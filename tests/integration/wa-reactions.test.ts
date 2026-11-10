import { createHash, randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { createLogger } from "@/lib/logger";
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import { createProperty } from "@/server/properties/service";
import { createReservation } from "@/server/reservations/service";
import { type AutoCloser, createAutoCloser } from "@/server/whatsapp/auto-close";
import { runCalendarWorker, type WorkerDeps } from "@/server/whatsapp/calendar/worker";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

/**
 * WhatsApp Asistanı A2f — işlem sonucu tepkileri (drizzle/0039, 0040). Gerçek PostgreSQL 17,
 * app_user, FORCE RLS. Zincir: ağ geçidinin kayıt fonksiyonu → worker (gerçek kod, otomatik kapatma
 * dahil) → tepki kuyruğu → ağ geçidinin alma/sonuç fonksiyonları (ağ geçidi koduyla aynı SQL).
 *
 * Doğrulananlar: ✅ yalnız otomatik blok oluşunca; ☑️ rezervasyon önerisinde; ⚠️ anlaşılmayan,
 * belirsiz tarihli ve çakışmalı mesajda; yetkisize ve sohbet mesajına tepki yok; aynı mesaja tek
 * tepki; tepki gönderilemese de (veya bağlantı kesikken) takvim ve öneriler aynen kalır; veritabanı
 * worker'ın kararını ayrıca doğrular (gerçek blok olmadan ✅ yazılamaz).
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 6 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const logLines: string[] = [];
const log = createLogger({ service: "wa-reaction-test" }, (l) => logLines.push(l));
const autoClose = createAutoCloser(app);
const deps = (over: WorkerDeps = {}): WorkerDeps => ({ log, autoClose, ...over });

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
const phoneHash = (pn: string) => createHash("sha256").update(`wa-phone:${pn}`).digest("hex");

const PN_OWNER = "905321660001";
const PN_MANAGER = "905321660002";
const PN_STAFF = "905321660003";
const PN_STRANGER = "905321660009";
const TODAY = istanbulToday();
const day = (n: number) => addDays(TODAY, n);
const AYLAR = [
  "Ocak",
  "Şubat",
  "Mart",
  "Nisan",
  "Mayıs",
  "Haziran",
  "Temmuz",
  "Ağustos",
  "Eylül",
  "Ekim",
  "Kasım",
  "Aralık",
];
const tr = (iso: string) => `${Number(iso.slice(8, 10))} ${AYLAR[Number(iso.slice(5, 7)) - 1]}`;
const OK = "✅";
const SUBMIT = "☑️";
const WARN = "⚠️";

let O: U, M: U, S: U;
let ws: string, villaId: string, conn: string, otherConn: string;
let G: { id: string; jid: string };
const planCode = `wa_rx_${tag}`;
const GROUP_JID = () =>
  `120367${String(Date.now()).slice(-7)}${randomBytes(2).readUInt16BE()}@g.us`;

let msgN = 0;
async function send(body: string, opts: { pn?: string; over?: WorkerDeps } = {}) {
  const mid = `RX${tag}${++msgN}`;
  const s = (
    await appPool.query<{ s: string }>(
      "select public.app_wa_ingest_message($1, $2, $3, $4, $5, null, $6, now(), 'live') as s",
      [conn, G.jid, mid, `${900 + msgN}@lid`, opts.pn ?? PN_OWNER, body],
    )
  ).rows[0]!.s;
  const summary = await runCalendarWorker(app, deps(opts.over));
  const m = (
    await admin.query<{ id: string; status: string }>(
      "select id, status from wa_inbound_messages where wa_message_id = $1",
      [mid],
    )
  ).rows[0];
  const reaction = m
    ? (await admin.query("select * from wa_message_reactions where message_id = $1", [m.id]))
        .rows[0]
    : undefined;
  return { mid, ingest: s, message: m, reaction, summary };
}
const claim = async (connection = conn, limit = 20) =>
  (
    await appPool.query(
      "select message_id, lock_token, group_jid, wa_message_id, sender_jid, emoji from public.app_wa_claim_reactions($1, $2)",
      [connection, limit],
    )
  ).rows;
const finish = async (id: string, token: string, ok: boolean, code: string | null = null) =>
  (
    await appPool.query<{ r: string }>(
      "select public.app_wa_finish_reaction($1, $2, $3, $4) as r",
      [id, token, ok, code],
    )
  ).rows[0]!.r;
const queue = async (id: string, kind: string) =>
  (
    await appPool.query<{ r: string }>("select public.app_wa_queue_reaction($1, $2) as r", [
      id,
      kind,
    ])
  ).rows[0]!.r;
async function calendarDigest() {
  return (
    await admin.query(
      `select count(*)::int as n, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as h
         from reservations t where t.workspace_id = $1`,
      [ws],
    )
  ).rows[0];
}
/** Testler arası: bekleyen tepkileri gönderilmiş say (alma sırası testleri karışmasın). */
const drain = async () => {
  for (const r of await claim()) await finish(r.message_id, r.lock_token, true);
};

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("waro");
  M = await mkUser("warm");
  S = await mkUser("wars");
  ws = (await createWorkspace(app, { userId: O.id, name: "Tepki", slug: `war-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'WA rx', 20, 14, true, false)",
    [planId, planCode],
  );
  await admin.query("update workspace_subscriptions set plan_id = $1 where workspace_id = $2", [
    planId,
    ws,
  ]);
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
  villaId = await as(O, ws, (tx, ctx) =>
    createProperty(tx, ctx, {
      name: "Villa In Love",
      propertyType: "villa",
      maxGuests: "6",
      bedrooms: "3",
      bathrooms: "2",
      province: "Antalya",
      district: "Kaş",
    }),
  );
  const hb = async (label: string) =>
    (
      await appPool.query<{ id: string }>(
        "select public.app_wa_heartbeat($1, 'open', null) as id",
        [label],
      )
    ).rows[0]!.id;
  conn = await hb(`war-${tag}`);
  otherConn = await hb(`war2-${tag}`);
  for (const [u, pn] of [
    [O, PN_OWNER],
    [M, PN_MANAGER],
    [S, PN_STAFF],
  ] as const) {
    await admin.query(
      "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 01')",
      [u.id, phoneHash(pn)],
    );
  }
  const jid = GROUP_JID();
  await appPool.query(
    "select public.app_wa_sync_group($1, $2, 'villa testo', 4, false, false, true)",
    [conn, jid],
  );
  const gid = (await admin.query("select id from wa_groups where jid = $1", [jid])).rows[0].id;
  await admin.query(
    "update wa_groups set status = 'linked', workspace_id = $2, property_id = $3, linked_at = now() where id = $1",
    [gid, ws, villaId],
  );
  G = { id: gid, jid };
  await runCalendarWorker(app, deps()); // ilk aktivasyon
});

afterAll(async () => {
  await admin.query("delete from wa_inbound_messages where workspace_id = $1", [ws]);
  await admin.query(
    "update workspace_subscriptions set plan_id = (select id from plans where is_default) where workspace_id = $1",
    [ws],
  );
  await admin.query("delete from plans where code = $1", [planCode]);
  await admin.end();
  await appPool.end();
});

describe("tepki kararı (worker → kuyruk)", () => {
  it("otomatik blok başarılı → ✅; ağ geçidi mesajın anahtarıyla alır ve 'sent' yazar", async () => {
    const r = await send(`Villa Testo ${tr(day(30))}–${tr(day(34))} kapatalım.`);
    expect(r.summary).toMatchObject({ autoClosed: 1, reactions: 1 });
    expect(r.reaction).toMatchObject({ kind: "done", emoji: OK, status: "pending", attempts: 0 });
    const claimed = await claim();
    expect(claimed).toEqual([
      {
        message_id: r.message!.id,
        lock_token: expect.any(String),
        group_jid: G.jid,
        wa_message_id: r.mid,
        sender_jid: `${900 + msgN}@lid`,
        emoji: OK,
      },
    ]);
    expect(await finish(claimed[0].message_id, claimed[0].lock_token, true)).toBe("sent");
    const row = (
      await admin.query("select * from wa_message_reactions where message_id = $1", [r.message!.id])
    ).rows[0];
    expect(row).toMatchObject({ status: "sent", attempts: 1, lock_token: null });
    expect(row.sent_at).toBeInstanceOf(Date);
    expect(await claim()).toEqual([]);
  });

  it("rezervasyon önerisi oluştu → ☑️ (✅ değil; rezervasyon oluşmadı)", async () => {
    const before = await calendarDigest();
    const r = await send(
      `Villa In Love ${tr(day(40))} giriş, ${tr(day(44))} çıkış, 4 kişi rezervasyon.`,
    );
    expect(r.reaction).toMatchObject({ kind: "submitted", emoji: SUBMIT });
    expect(await calendarDigest()).toEqual(before);
    await drain();
  });

  it("mesaj ayrıştırılamadı (tarih yok / çelişen eylem) → ⚠️", async () => {
    for (const body of [
      "Villa In Love kapatalım",
      `Villa In Love ${tr(day(50))}-${tr(day(52))} kapalı ama rezervasyon da olabilir`,
    ]) {
      const r = await send(body);
      expect([body, r.reaction?.kind]).toEqual([body, "warning"]);
      expect(r.reaction.emoji).toBe(WARN);
    }
    await drain();
  });

  it("tarih belirsiz (tek tarih) → ⚠️", async () => {
    const r = await send(`Villa In Love ${tr(day(60))} kapatalım`);
    expect(r.reaction).toMatchObject({ kind: "warning", emoji: WARN });
    await drain();
  });

  it("takvim çakışması → ⚠️; takvim değişmez", async () => {
    await as(O, ws, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "reservation",
        propertyId: villaId,
        checkIn: day(70),
        checkOut: day(74),
        status: "confirmed",
        source: "phone",
        guestName: "Mevcut Misafir",
        adults: "2",
        children: "0",
      }),
    );
    const before = await calendarDigest();
    const r = await send(`Villa In Love ${tr(day(72))}–${tr(day(76))} kapatalım.`);
    expect(r.reaction).toMatchObject({ kind: "warning" });
    expect(await calendarDigest()).toEqual(before);
    await drain();
  });

  it("yetkisiz kullanıcı → tepki yok (personel ve kayıtsız numara)", async () => {
    const staff = await send(`Villa In Love ${tr(day(80))}–${tr(day(82))} kapatalım.`, {
      pn: PN_STAFF,
    });
    expect(staff.message!.status).toBe("processed");
    expect(staff.reaction).toBeUndefined();
    const stranger = await send(`Villa In Love ${tr(day(84))}–${tr(day(86))} kapatalım.`, {
      pn: PN_STRANGER,
    });
    expect(stranger.message!.status).toBe("ignored");
    expect(stranger.reaction).toBeUndefined();
    // Veritabanı da yetkisiz gönderenin mesajına tepki yazmaz.
    expect(await queue(staff.message!.id, "warning")).toBe("rejected");
  });

  it("takvimle ilgisiz sohbet ve soru → tepki yok", async () => {
    const chat = await send("Günaydın, havuzcu yarın 10'da gelecek");
    expect(chat.reaction).toBeUndefined();
    const q = await send(`Villa In Love ${tr(day(90))}–${tr(day(92))} müsait mi?`);
    expect(q.reaction).toBeUndefined();
  });

  it("aynı mesaj tekrar gelirse ikinci tepki yazılmaz", async () => {
    const r = await send(`Villa In Love ${tr(day(100))}–${tr(day(103))} kapatalım.`);
    expect(r.reaction).toMatchObject({ kind: "done" });
    // Ağ geçidinden yeniden teslim: duplicate, yeniden işlenmez.
    const again = await appPool.query<{ s: string }>(
      "select public.app_wa_ingest_message($1, $2, $3, $4, $5, null, 'tekrar', now(), 'live') as s",
      [conn, G.jid, r.mid, "x@lid", PN_OWNER],
    );
    expect(again.rows[0]!.s).toBe("duplicate");
    await runCalendarWorker(app, deps());
    // Kuyruğa ikinci kez yazma girişimi (ör. yeniden deneme) yeni satır üretmez.
    expect(await queue(r.message!.id, "done")).toBe("exists");
    expect(await queue(r.message!.id, "warning")).toBe("exists");
    const rows = await admin.query("select kind from wa_message_reactions where message_id = $1", [
      r.message!.id,
    ]);
    expect(rows.rows).toEqual([{ kind: "done" }]);
    await drain();
  });
});

describe("veritabanı kararı doğrular", () => {
  it("gerçek otomatik blok olmadan ✅ yazılamaz; bekleyen öneri yokken ☑️ yazılamaz", async () => {
    // Worker'ı tepkisiz çalıştırmak için kuyruğu sonradan temizleyip yeniden deneriz.
    const r = await send(
      `Villa In Love ${tr(day(110))} giriş, ${tr(day(114))} çıkış, 2 kişi rezervasyon.`,
    );
    await admin.query("delete from wa_message_reactions where message_id = $1", [r.message!.id]);
    expect(await queue(r.message!.id, "done")).toBe("rejected"); // rezervasyon önerisi: blok yok
    expect(await queue(r.message!.id, "submitted")).toBe("queued");
    await drain();
  });

  it("geçersiz tür reddedilir; işlenmemiş / eski mesaja tepki yazılmaz", async () => {
    await expect(queue(uuidv7(), "party")).rejects.toThrow();
    expect(await queue(uuidv7(), "warning")).toBe("rejected");
    const r = await send(`Villa In Love ${tr(day(120))} kapatalım`);
    await admin.query("delete from wa_message_reactions where message_id = $1", [r.message!.id]);
    await admin.query(
      "update wa_inbound_messages set processed_at = now() - interval '2 hours' where id = $1",
      [r.message!.id],
    );
    expect(await queue(r.message!.id, "warning")).toBe("rejected");
  });

  it("app_user ve ağ geçidi tabloya doğrudan erişemez (FORCE RLS, yetki yok)", async () => {
    const res = await appPool.query("select * from wa_message_reactions").then(
      () => "ok",
      (e: { code?: string }) => e.code,
    );
    expect(res).toBe("42501");
  });
});

describe("gönderim: yeniden deneme, idempotency ve hata yalıtımı", () => {
  it("tepki gönderilemezse takvim işlemi bozulmaz; artan beklemeyle yeniden denenir, sonra 'failed'", async () => {
    const r = await send(`Villa Testo ${tr(day(130))}–${tr(day(133))} kapatalım.`);
    expect(r.reaction).toMatchObject({ kind: "done" });
    const digest = await calendarDigest();
    const prop = (
      await admin.query(
        "select status, applied_reservation_ids from wa_calendar_proposals where message_id = $1",
        [r.message!.id],
      )
    ).rows[0];
    expect(prop.status).toBe("applied");

    const [c1] = await claim();
    expect(await finish(c1.message_id, c1.lock_token, false, "send_error")).toBe("retry");
    let row = (
      await admin.query("select * from wa_message_reactions where message_id = $1", [r.message!.id])
    ).rows[0];
    expect(row).toMatchObject({ status: "pending", attempts: 1, last_error: "send_error" });
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(await claim()).toEqual([]); // bekleme dolmadan alınmaz

    // Kalan denemeler (bekleme süresini öne çekerek).
    for (let i = 2; i <= 5; i++) {
      await admin.query(
        "update wa_message_reactions set next_attempt_at = now() - interval '1 second' where message_id = $1",
        [r.message!.id],
      );
      const [c] = await claim();
      expect(await finish(c.message_id, c.lock_token, false, "timeout")).toBe(
        i < 5 ? "retry" : "failed",
      );
    }
    row = (
      await admin.query("select * from wa_message_reactions where message_id = $1", [r.message!.id])
    ).rows[0];
    expect(row).toMatchObject({ status: "failed", attempts: 5, last_error: "timeout" });
    // Takvim ve öneri aynen duruyor.
    expect(await calendarDigest()).toEqual(digest);
    expect(
      (
        await admin.query("select status from wa_calendar_proposals where message_id = $1", [
          r.message!.id,
        ])
      ).rows[0].status,
    ).toBe("applied");
  });

  it("kilit belirteci uyuşmazsa ('lost') hiçbir şey yazılmaz; kilidi dolan tepki yeniden alınır", async () => {
    const r = await send(
      `Villa In Love ${tr(day(140))} giriş, ${tr(day(143))} çıkış, 2 kişi rezervasyon.`,
    );
    const [c] = await claim();
    expect(c.message_id).toBe(r.message!.id);
    expect(await finish(c.message_id, uuidv7(), true)).toBe("lost");
    expect(await claim()).toEqual([]); // kilitli
    await admin.query(
      "update wa_message_reactions set locked_until = now() - interval '1 second' where message_id = $1",
      [r.message!.id],
    );
    const [again] = await claim();
    expect(again.message_id).toBe(r.message!.id);
    expect(again.lock_token).not.toBe(c.lock_token);
    expect(await finish(c.message_id, c.lock_token, true)).toBe("lost"); // eski kilit
    expect(await finish(again.message_id, again.lock_token, true)).toBe("sent");
  });

  it("bağlantı kesik / başka bağlantı: tepki bekler; mesaj kuyruğu ve takvim işler", async () => {
    // Ağ geçidi bağlı değilken worker çalışmaya devam eder; tepki yalnız kuyrukta bekler.
    const r = await send(`Villa Testo ${tr(day(150))}–${tr(day(152))} kapatalım.`);
    expect(r.message!.status).toBe("processed");
    expect(r.summary.autoClosed).toBe(1);
    expect(r.reaction).toMatchObject({ status: "pending" });
    // Başka bir bağlantı (ör. ikinci numara) bu grubun tepkisini alamaz.
    expect(await claim(otherConn)).toEqual([]);
    // Bağlantı geri gelince alınır.
    const [c] = await claim();
    expect(c.message_id).toBe(r.message!.id);
    expect(await finish(c.message_id, c.lock_token, true)).toBe("sent");
  });

  it("24 saatten eski tepki gönderilmez ('expired')", async () => {
    const r = await send(
      `Villa In Love ${tr(day(160))} giriş, ${tr(day(163))} çıkış, 2 kişi rezervasyon.`,
    );
    await admin.query(
      "update wa_message_reactions set created_at = now() - interval '25 hours' where message_id = $1",
      [r.message!.id],
    );
    expect(await claim()).toEqual([]);
    expect(
      (
        await admin.query("select status from wa_message_reactions where message_id = $1", [
          r.message!.id,
        ])
      ).rows[0].status,
    ).toBe("expired");
  });

  it("mesaj silinince (saklama / bağlantı kesme) tepki satırı da silinir", async () => {
    const r = await send(`Villa In Love ${tr(day(170))} kapatalım`);
    expect(r.reaction).toBeDefined();
    await admin.query("delete from wa_inbound_messages where id = $1", [r.message!.id]);
    expect(
      (
        await admin.query(
          "select count(*)::int n from wa_message_reactions where message_id = $1",
          [r.message!.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("tepki kuyruğa yazılamasa da (veritabanı hatası) mesaj işlenir ve blok oluşur", async () => {
    const failing: AutoCloser = async (req) => autoClose(req);
    // Kuyruğa yazmayı bozmak için fonksiyon yetkisini geçici olarak kaldır (yalnız bu test).
    await admin.query(
      "revoke execute on function public.app_wa_queue_reaction(uuid, text) from app_user",
    );
    try {
      const r = await send(`Villa Testo ${tr(day(180))}–${tr(day(182))} kapatalım.`, {
        over: { autoClose: failing },
      });
      expect(r.message!.status).toBe("processed");
      expect(r.summary).toMatchObject({ autoClosed: 1, reactions: 0, failed: 0 });
      expect(r.reaction).toBeUndefined();
    } finally {
      await admin.query(
        "grant execute on function public.app_wa_queue_reaction(uuid, text) to app_user",
      );
    }
    expect(logLines.join("\n")).toContain("wa_calendar_reaction_failed");
  });

  it("log'da mesaj metni ve numara yok", () => {
    const all = logLines.join("\n");
    for (const f of [
      PN_OWNER,
      PN_MANAGER,
      PN_STAFF,
      "kapatalım",
      "Mevcut Misafir",
      "Villa In Love",
    ])
      expect([f, all.includes(f)]).toEqual([f, false]);
  });
});
