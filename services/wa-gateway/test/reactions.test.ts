import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { AuthenticationState, WAMessage, WASocket } from "baileys";

import { loadConfig } from "../src/config.ts";
import { explainGroupMessage } from "../src/extract.ts";
import type { Lease } from "../src/lease.ts";
import { WaGateway } from "../src/session.ts";
import type { QueuedReaction, WaStore } from "../src/store.ts";

/**
 * A2f — işlem sonucu tepkileri (kuyruktan). WhatsApp'a bağlanmadan: sahte soket ve sahte
 * veritabanı. Doğrulananlar: tepki mesajın ÜZERİNE reaction olarak gider (metin yok), yalnız bağlantı
 * açık ve kilit bizdeyken kuyruktan alınır, gönderim hatası sonucu yeniden denemeye bırakır ve
 * süreci bozmaz, kendi tepkilerimiz yeniden işlenmez (döngü yok).
 */
const FAST = {
  backoffBaseMs: 5,
  backoffCapMs: 20,
  unavailableBaseMs: 5,
  authTimeoutMs: 80,
  leaseTimeoutMs: 80,
  leaseRetryMs: 10,
  stableOpenMs: 30,
  heartbeatMs: 10_000_000,
  watchdogTickMs: 10_000_000,
  pendingRetryMs: 10_000_000,
  reactionPollMs: 10_000_000, // testte elle tetiklenir (flushReactions)
  reactionSendTimeoutMs: 50,
};

type Sent = { jid: string; content: unknown };
type FakeSock = WASocket & {
  ev: EventEmitter;
  ended: boolean;
  sent: Sent[];
  fail: number;
  hang: boolean;
};

function fakeSocket(): FakeSock {
  const ev = new EventEmitter();
  const s = {
    ev,
    ended: false,
    sent: [] as Sent[],
    fail: 0,
    hang: false,
    user: { id: "905321112233:7@s.whatsapp.net" },
    end() {
      s.ended = true;
    },
    async logout() {},
    async groupFetchAllParticipating() {
      return {};
    },
    async groupMetadata() {
      throw new Error("yok");
    },
    signalRepository: { lidMapping: { getPNForLID: async () => null } },
    async sendMessage(jid: string, content: unknown) {
      if (s.hang) return new Promise(() => undefined);
      if (s.fail > 0) {
        s.fail -= 1;
        throw new Error("Connection Closed");
      }
      s.sent.push({ jid, content });
      return { key: { id: `R${s.sent.length}` } };
    },
  };
  return s as unknown as FakeSock;
}

class FakeLease implements Lease {
  held = false;
  async acquire() {
    this.held = true;
    return true;
  }
  onLost() {}
  async release() {
    this.held = false;
  }
}

const Q = (n: number): QueuedReaction => ({
  messageId: `m${n}`,
  lockToken: `t${n}`,
  groupJid: "120363000000000001@g.us",
  waMessageId: `WAID${n}`,
  senderJid: `9876543210${n}@lid`,
  emoji: "✅",
});

function fakeStore(queue: QueuedReaction[]) {
  const claims: number[] = [];
  const finished: { id: string; ok: boolean; code: string | null }[] = [];
  let finishFails = 0;
  const store = {
    async heartbeat() {
      return "c1";
    },
    async syncGroup() {
      return "discovered";
    },
    async verifyPhone() {
      return "invalid";
    },
    async ingest() {
      return "stored";
    },
    async purge() {
      return 0;
    },
    async claimReactions(limit: number) {
      claims.push(limit);
      return queue.splice(0, limit);
    },
    async finishReaction(r: QueuedReaction, ok: boolean, code: string | null) {
      if (finishFails > 0) {
        finishFails -= 1;
        throw Object.assign(new Error("db down"), { code: "57P01" });
      }
      finished.push({ id: r.messageId, ok, code });
      return ok ? "sent" : "retry";
    },
  };
  return {
    store: store as unknown as WaStore,
    claims,
    finished,
    failFinish(n: number) {
      finishFails = n;
    },
  };
}

async function setup(queue: QueuedReaction[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-react-"));
  const config = loadConfig(
    { WA_ALLOWED_NUMBER: "905321112233", WA_DATABASE_URL: "postgres://u:p@localhost/lodging_dev" },
    dir,
  );
  fs.mkdirSync(config.authDir, { mode: 0o700 });
  const sockets: FakeSock[] = [];
  const lease = new FakeLease();
  const st = fakeStore(queue);
  const gw = new WaGateway(config, st.store, {
    makeSocket: () => {
      const s = fakeSocket();
      sockets.push(s);
      return s;
    },
    loadAuth: async () => ({
      state: { creds: {}, keys: {} } as unknown as AuthenticationState,
      saveCreds: async () => undefined,
    }),
    lease,
    timing: FAST,
  });
  return { gw, sockets, lease, st };
}

const waitFor = async (cond: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("zaman aşımı");
    await new Promise((r) => setTimeout(r, 2));
  }
};
const openSock = async (gw: WaGateway, s: FakeSock) => {
  s.ev.emit("connection.update", { connection: "open" });
  await waitFor(() => gw.status === "open");
};

describe("işlem tepkisi gönderimi (A2f)", () => {
  it("bağlantı açıkken kuyruktaki tepki mesajın ÜZERİNE reaction olarak gider; sonuç yazılır", async () => {
    const { gw, sockets, st } = await setup([Q(1)]);
    await gw.start();
    await openSock(gw, sockets[0]!);
    await gw.flushReactions();
    assert.equal(sockets[0]!.sent.length, 1);
    assert.deepEqual(sockets[0]!.sent[0], {
      jid: "120363000000000001@g.us",
      content: {
        react: {
          text: "✅",
          key: {
            remoteJid: "120363000000000001@g.us",
            id: "WAID1",
            participant: "98765432101@lid",
            fromMe: false,
          },
        },
      },
    });
    // Metin mesajı YOK: içerik yalnız "react".
    assert.deepEqual(Object.keys(sockets[0]!.sent[0]!.content as object), ["react"]);
    assert.deepEqual(st.finished, [{ id: "m1", ok: true, code: null }]);
    assert.equal(gw.stats.reactionsSent, 1);
    await gw.stop();
  });

  it("bağlantı kesikken kuyruktan hiçbir şey alınmaz (kuyruk güvenle bekler)", async () => {
    const queue = [Q(1), Q(2)];
    const { gw, sockets, st } = await setup(queue);
    await gw.start();
    await gw.flushReactions(); // henüz açık değil
    assert.deepEqual(st.claims, []);
    await openSock(gw, sockets[0]!);
    sockets[0]!.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    assert.notEqual(gw.status, "open");
    await gw.flushReactions();
    // Açıkken (onOpen) bir kez alınmış olabilir; kapalıyken yeni alma yok.
    const claimsWhileClosed = st.claims.length;
    await gw.flushReactions();
    assert.equal(st.claims.length, claimsWhileClosed);
    await gw.stop();
  });

  it("kopya kilidi bizde değilse gönderilmez", async () => {
    const { gw, sockets, lease, st } = await setup([Q(1)]);
    await gw.start();
    await openSock(gw, sockets[0]!);
    const before = st.claims.length;
    lease.held = false;
    await gw.flushReactions();
    assert.equal(st.claims.length, before);
    await gw.stop();
  });

  it("gönderim hatası: yeniden denemeye bırakılır (kısa kod), süreç ve bağlantı etkilenmez", async () => {
    const { gw, sockets, st } = await setup([Q(1)]);
    await gw.start();
    sockets[0]!.fail = 1;
    await openSock(gw, sockets[0]!);
    await gw.flushReactions();
    assert.deepEqual(st.finished, [{ id: "m1", ok: false, code: "send_error" }]);
    assert.equal(gw.stats.reactionsFailed, 1);
    assert.equal(gw.status, "open");
    await gw.stop();
  });

  it("gönderim takılırsa süre sınırıyla 'timeout' yazılır", async () => {
    const { gw, sockets, st } = await setup([Q(1)]);
    await gw.start();
    sockets[0]!.hang = true;
    await openSock(gw, sockets[0]!);
    await gw.flushReactions();
    assert.deepEqual(st.finished, [{ id: "m1", ok: false, code: "timeout" }]);
    await gw.stop();
  });

  it("sonuç veritabanına yazılamazsa çökmez; hata sayılır (kilit dolunca yeniden alınır)", async () => {
    const { gw, sockets, st } = await setup([Q(1)]);
    await gw.start();
    st.failFinish(1);
    await openSock(gw, sockets[0]!);
    await gw.flushReactions();
    assert.equal(sockets[0]!.sent.length, 1);
    assert.equal(st.finished.length, 0);
    assert.ok(gw.stats.errors >= 1);
    assert.equal(gw.status, "open");
    await gw.stop();
  });

  it("dakikadaki tepki sınırı aşılmaz (kuyruktan sınır kadar alınır)", async () => {
    const queue = Array.from({ length: 30 }, (_, i) => Q(i + 1));
    const { gw, sockets, st } = await setup(queue);
    await gw.start();
    await openSock(gw, sockets[0]!);
    for (let i = 0; i < 5; i++) await gw.flushReactions();
    assert.equal(sockets[0]!.sent.length, 10);
    assert.ok(st.claims.every((n) => n >= 1 && n <= 5));
    await gw.stop();
  });

  it("eşzamanlı yoklamalar tek uçuş: aynı tepki iki kez alınmaz", async () => {
    const { gw, sockets, st } = await setup([Q(1)]);
    await gw.start();
    await openSock(gw, sockets[0]!);
    await Promise.all([gw.flushReactions(), gw.flushReactions(), gw.flushReactions()]);
    assert.equal(sockets[0]!.sent.length, 1);
    assert.equal(st.finished.length, 1);
    await gw.stop();
  });
});

/**
 * Regresyon (canlı arıza, 2026-11-10): bağlantı kesikken (veya kilit/bağlantı yokken) yapılan bir
 * yoklama, "tek uçuş" kilidini bitmiş bir promise olarak bırakıyordu; sonraki TÜM yoklamalar
 * kuyruğa hiç bakmadan dönüyordu. 428 kopması + yeniden bağlantıdan sonra hiçbir tepki gitmedi.
 */
describe("bağlantı kopup geri gelince tepki kuyruğu yeniden çalışır (regresyon)", () => {
  it("bağlantı açılmadan önceki yoklama, açıldıktan sonraki gönderimi engellemez", async () => {
    const queue: QueuedReaction[] = [];
    const { gw, sockets, st } = await setup(queue);
    await gw.start();
    await gw.flushReactions(); // henüz açık değil: erken çıkış
    assert.deepEqual(st.claims, []);
    await openSock(gw, sockets[0]!);
    await waitFor(() => st.claims.length >= 1); // bağlanınca yapılan yoklama (kuyruk boş)
    await gw.flushReactions(); // varsa süren uçuşun bitmesi
    queue.push(Q(1));
    await gw.flushReactions();
    assert.equal(sockets[0]!.sent.length, 1);
    assert.deepEqual(st.finished, [{ id: "m1", ok: true, code: null }]);
    await gw.stop();
  });

  it("428 kopması → kesikken yoklama → yeniden bağlantı: yeni sokete tepki gider", async () => {
    const queue = [Q(1)];
    const { gw, sockets, st } = await setup(queue);
    await gw.start();
    await openSock(gw, sockets[0]!);
    await gw.flushReactions();
    assert.equal(sockets[0]!.sent.length, 1);
    sockets[0]!.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    assert.notEqual(gw.status, "open");
    // Kopukken zamanlayıcı yoklaması (canlıdaki durum): erken çıkış, kuyruk alınmaz.
    const claimsBefore = st.claims.length;
    await gw.flushReactions();
    await gw.flushReactions();
    assert.equal(st.claims.length, claimsBefore);
    // Yeniden bağlanma (aynı oturum; yeni soket).
    await waitFor(() => sockets.length === 2);
    await openSock(gw, sockets[1]!);
    await waitFor(() => st.claims.length > claimsBefore); // bağlanınca yapılan yoklama
    await gw.flushReactions();
    queue.push(Q(2));
    await gw.flushReactions();
    assert.equal(sockets[1]!.sent.length, 1);
    assert.equal(
      (sockets[1]!.sent[0]!.content as { react: { key: { id: string } } }).react.key.id,
      "WAID2",
    );
    assert.deepEqual(
      st.finished.map((f) => [f.id, f.ok]),
      [
        ["m1", true],
        ["m2", true],
      ],
    );
    await gw.stop();
  });

  it("kopya kilidi geçici olarak kaybedilip geri gelince kuyruk yeniden alınır", async () => {
    const queue: QueuedReaction[] = [];
    const { gw, sockets, lease, st } = await setup(queue);
    await gw.start();
    await openSock(gw, sockets[0]!);
    lease.held = false;
    await gw.flushReactions(); // kilit yok: erken çıkış
    lease.held = true;
    queue.push(Q(1));
    await gw.flushReactions();
    assert.equal(sockets[0]!.sent.length, 1);
    assert.equal(st.finished.length, 1);
    await gw.stop();
  });

  it("dakikalık sınır dolu yoklama (bütçe 0) sonraki yoklamaları kilitlemez", async () => {
    const queue = Array.from({ length: 10 }, (_, i) => Q(i + 1));
    const { gw, sockets, st } = await setup(queue);
    await gw.start();
    await openSock(gw, sockets[0]!);
    for (let i = 0; i < 3; i++) await gw.flushReactions();
    assert.equal(sockets[0]!.sent.length, 10);
    const claims = st.claims.length;
    await gw.flushReactions(); // bütçe 0: erken çıkış
    assert.equal(st.claims.length, claims);
    // Tek uçuş kilidi serbest kaldı: yeni yoklama yeniden değerlendirilir (bütçe hâlâ 0).
    const p = gw.flushReactions();
    assert.ok(p instanceof Promise);
    await p;
    assert.equal(st.claims.length, claims);
    await gw.stop();
  });

  it("gönderilen tepkinin sunucu onayı ve reddi loglanır", async () => {
    const { gw, sockets } = await setup([Q(1), Q(2)]);
    await gw.start();
    await openSock(gw, sockets[0]!);
    await gw.flushReactions();
    assert.equal(sockets[0]!.sent.length, 2);
    // Sahte soket gönderim kimlikleri: R1, R2.
    sockets[0]!.ev.emit("messages.update", [
      { key: { id: "R1" }, update: { status: 2 } }, // SERVER_ACK
      { key: { id: "R2" }, update: { status: 0 } }, // ERROR
    ]);
    const texts = gw.events.map((e) => e.text);
    assert.ok(
      texts.some((t) => t.includes("Tepki sunucuya ulaştı (✅ → WAID1)")),
      texts.join(" | "),
    );
    assert.ok(texts.some((t) => t.includes("Tepki sunucu tarafından reddedildi (✅ → WAID2)")));
    await gw.stop();
  });
});

describe("döngü yok: kendi tepkilerimiz yeniden işlenmez", () => {
  const ours = (content: WAMessage["message"]) =>
    ({
      key: { remoteJid: "120363000000000001@g.us", id: "R1", fromMe: true, participant: "" },
      message: content,
      messageTimestamp: 1_800_000_000,
    }) as unknown as WAMessage;

  it("asistanın gönderdiği reaction kaydedilmez", () => {
    const r = explainGroupMessage(ours({ reactionMessage: { text: "✅", key: { id: "WAID1" } } }));
    assert.equal(r.ok, false);
  });

  it("başkasının reaction'ı da metin değildir, kaydedilmez", () => {
    const m = ours({ reactionMessage: { text: "✅", key: { id: "WAID1" } } });
    m.key.fromMe = false;
    m.key.participant = "905321112299@s.whatsapp.net";
    const r = explainGroupMessage(m);
    assert.deepEqual(r.ok ? null : r.reason, "reaction");
  });
});
