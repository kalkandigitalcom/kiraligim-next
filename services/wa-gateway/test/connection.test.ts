import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { AuthenticationState, WAMessage, WASocket } from "baileys";

import { loadConfig } from "../src/config.ts";
import type { Lease } from "../src/lease.ts";
import { type GatewayDeps, WaGateway } from "../src/session.ts";
import type { InboundRecord, WaStore } from "../src/store.ts";
import { RestartHistory } from "../src/watchdog.ts";

/**
 * Aşama 1 — kendini kurtaran bağlantı. WhatsApp'a bağlanmadan: soket üretici sahte bir olay
 * yayıcısı döndürür, kapanma kodları elle üretilir. Oturum klasörü geçici bir dizindir; gerçek
 * oturuma dokunulmaz.
 */
const FAST = {
  backoffBaseMs: 5,
  backoffCapMs: 20,
  unavailableBaseMs: 5,
  replacedCooldownMinMs: 5,
  replacedCooldownMaxMs: 10,
  authTimeoutMs: 80,
  leaseTimeoutMs: 80,
  leaseRetryMs: 10,
  stableOpenMs: 30,
  heartbeatMs: 10_000_000,
  watchdogTickMs: 10_000_000,
  healthGraceMs: 1_000,
  ingestRetryMs: [1, 1, 1],
  pendingRetryMs: 10_000_000,
  pendingMax: 3,
  flushTimeoutMs: 300,
};

type FakeSock = WASocket & { ev: EventEmitter; ended: boolean; loggedOut: boolean };

function fakeSocket(): FakeSock {
  const ev = new EventEmitter();
  const s = {
    ev,
    ended: false,
    loggedOut: false,
    user: { id: "905321112233:7@s.whatsapp.net" },
    end() {
      s.ended = true;
    },
    async logout() {
      s.loggedOut = true;
    },
    async groupFetchAllParticipating() {
      return {};
    },
    async groupMetadata() {
      throw new Error("yok");
    },
    signalRepository: { lidMapping: { getPNForLID: async () => null } },
    async sendMessage() {
      return undefined;
    },
  };
  return s as unknown as FakeSock;
}

const tmpService = () => fs.mkdtempSync(path.join(os.tmpdir(), "wa-svc-"));
const auth = async () => ({
  state: { creds: {}, keys: {} } as unknown as AuthenticationState,
  saveCreds: async () => undefined,
});
const waitFor = async (cond: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("zaman aşımı");
    await new Promise((r) => setTimeout(r, 2));
  }
};
const open = (s: FakeSock) => s.ev.emit("connection.update", { connection: "open" });
const close = (s: FakeSock, code?: number) =>
  s.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: {
      error: code === undefined ? new Error("x") : { output: { statusCode: code } },
    },
  });

class FakeLease implements Lease {
  held = false;
  answers: (boolean | Error)[] = [];
  private lost: (() => void) | null = null;
  calls = 0;
  released = 0;
  async acquire() {
    this.calls += 1;
    const a = this.answers.length ? this.answers.shift()! : true;
    if (a instanceof Error) throw a;
    this.held = a;
    return a;
  }
  onLost(cb: () => void) {
    this.lost = cb;
  }
  lose() {
    this.held = false;
    this.lost?.();
  }
  async release() {
    this.held = false;
    this.released += 1;
  }
}

function fakeStore() {
  const hb: [string, string | null][] = [];
  const ingested: InboundRecord[] = [];
  let failures = 0;
  const store = {
    async heartbeat(status: string, code: string | null) {
      hb.push([status, code]);
      return "c1";
    },
    async syncGroup() {
      return "discovered";
    },
    async verifyPhone() {
      return "invalid";
    },
    async ingest(m: InboundRecord) {
      if (failures > 0) {
        failures -= 1;
        throw Object.assign(new Error("db down"), { code: "57P01" });
      }
      ingested.push(m);
      return "stored";
    },
    async purge() {
      return 0;
    },
  };
  return {
    store: store as unknown as WaStore,
    hb,
    ingested,
    fail(n: number) {
      failures = n;
    },
  };
}

function setup(over: Partial<GatewayDeps> & { db?: boolean; env?: Record<string, string> } = {}) {
  const dir = tmpService();
  const config = loadConfig(
    {
      WA_ALLOWED_NUMBER: "905321112233",
      ...(over.db === false ? {} : { WA_DATABASE_URL: "postgres://u:p@localhost/lodging_dev" }),
      ...over.env,
    },
    dir,
  );
  fs.mkdirSync(config.authDir, { mode: 0o700 });
  // Gerçek bir oturumu taklit eden dosyalar: hiçbir kapanmada silinmemeli.
  fs.writeFileSync(path.join(config.authDir, "creds.json"), '{"me":{"id":"x"}}');
  fs.writeFileSync(path.join(config.authDir, "session-1.json"), "{}");
  const sockets: FakeSock[] = [];
  const versions: unknown[] = [];
  const lease = (over.lease as FakeLease | undefined) ?? new FakeLease();
  const st = fakeStore();
  const gw = new WaGateway(config, over.db === false ? null : st.store, {
    makeSocket: (o) => {
      versions.push(o.version);
      const s = fakeSocket();
      sockets.push(s);
      return s;
    },
    loadAuth: auth,
    lease,
    timing: FAST,
    ...over,
  });
  const live = () => sockets.filter((s) => !s.ended);
  const authIntact = () =>
    fs.existsSync(path.join(config.authDir, "creds.json")) &&
    fs.existsSync(path.join(config.authDir, "session-1.json"));
  return { gw, sockets, live, lease, st, config, versions, authIntact };
}

describe("tek uçuş ve yeniden bağlanma", () => {
  it("eşzamanlı başlatmalar tek soket açar; kapanınca eski soket kapatılır, dinleyicileri kaldırılır", async () => {
    const { gw, sockets, live } = setup();
    await Promise.all([gw.start(), gw.start(), gw.start()]);
    assert.equal(sockets.length, 1);
    open(sockets[0]!);
    await waitFor(() => gw.status === "open");
    close(sockets[0]!, 428);
    assert.equal(gw.status, "backoff");
    assert.equal(sockets[0]!.ended, true);
    assert.equal(sockets[0]!.ev.listenerCount("connection.update"), 0);
    await waitFor(() => sockets.length === 2);
    assert.equal(live().length, 1);
    // Eski soketin geç gelen olayı yeni durumu etkilemez.
    sockets[0]!.ev.emit("connection.update", { connection: "open" });
    assert.notEqual(gw.status, "open");
    await gw.stop();
  });

  it("428 → 503 → 500 → 515 → open: sırayla, her an en fazla bir canlı soket", async () => {
    const { gw, sockets, live } = setup();
    await gw.start();
    for (const code of [428, 503, 500, 515]) {
      const n = sockets.length;
      close(sockets.at(-1)!, code);
      assert.ok(live().length <= 1);
      await waitFor(() => sockets.length === n + 1);
      assert.equal(live().length, 1, String(code));
    }
    open(sockets.at(-1)!);
    await waitFor(() => gw.status === "open");
    assert.equal(gw.stats.reconnects, 4);
    await gw.stop();
  });

  it("kodu belirsiz akış hatası (500) art arda gelse de DURMAZ; 5. seferde degraded", async () => {
    const { gw, sockets } = setup();
    await gw.start();
    for (let i = 0; i < 6; i++) {
      const n = sockets.length;
      close(sockets.at(-1)!, 500);
      await waitFor(() => sockets.length === n + 1);
    }
    assert.equal(gw.degraded, true);
    assert.notEqual(gw.status, "stopped");
    await gw.stop();
  });

  it("bağlantı kurulumu hata verirse sessizce takılmaz: yeniden denenir", async () => {
    let calls = 0;
    const { gw, sockets } = setup({
      loadAuth: async (d) => {
        calls += 1;
        if (calls === 1) throw new Error("EIO okuma hatası");
        return auth();
      },
    });
    await gw.start();
    assert.equal(gw.status, "backoff");
    await waitFor(() => sockets.length === 1);
    assert.equal(gw.status, "connecting");
    await gw.stop();
  });

  it("oturum yüklemesi hiç dönmezse zaman aşımı → yeniden deneme", async () => {
    let calls = 0;
    const { gw, sockets } = setup({
      loadAuth: (d) => {
        calls += 1;
        return calls === 1 ? new Promise(() => undefined) : auth();
      },
    });
    await gw.start();
    assert.equal(gw.lastCode, "auth_timeout");
    await waitFor(() => sockets.length === 1);
    await gw.stop();
  });

  it("elle sıfırlama ile zamanlayıcı yarışında yine tek canlı soket", async () => {
    const { gw, sockets, live } = setup();
    await gw.start();
    close(sockets[0]!, 428);
    await gw.reset();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(live().length, 1);
    await gw.stop();
  });

  it("kurulum sürerken kapanış: yeni soket açılmaz, kilit bırakılır", async () => {
    let resolveAuth!: () => void;
    const gate = new Promise<void>((r) => (resolveAuth = r));
    const { gw, sockets, lease } = setup({
      timing: { ...FAST, authTimeoutMs: 5_000 },
      loadAuth: async () => {
        await gate;
        return auth();
      },
    });
    const started = gw.start();
    await new Promise((r) => setTimeout(r, 10));
    const stopping = gw.stop();
    resolveAuth();
    await Promise.all([started, stopping]);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sockets.length, 0);
    assert.equal((lease as FakeLease).released, 1);
    assert.equal(gw.status, "stopped");
  });
});

describe("oturum asla otomatik silinmez", () => {
  for (const code of [401, 411]) {
    it(`${code}: needs_qr, oturum dosyaları yerinde, yeni deneme yok`, async () => {
      const { gw, sockets, authIntact, st } = setup();
      await gw.start();
      open(sockets[0]!);
      await waitFor(() => gw.status === "open");
      close(sockets[0]!, code);
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(gw.status, "needs_qr");
      assert.equal(sockets.length, 1);
      assert.equal(authIntact(), true);
      assert.deepEqual(st.hb.at(-1), ["logged_out", `needs_qr_${code}`]);
      assert.equal(gw.health().ok, false);
      await gw.stop();
      assert.equal(authIntact(), true);
    });
  }

  it("403 blocked; 440 üç kez → replaced; hiçbiri oturumu silmez", async () => {
    const a = setup();
    await a.gw.start();
    close(a.sockets[0]!, 403);
    assert.equal(a.gw.status, "blocked");
    assert.equal(a.authIntact(), true);
    await a.gw.stop();

    const b = setup();
    await b.gw.start();
    for (let i = 0; i < 2; i++) {
      const n = b.sockets.length;
      close(b.sockets.at(-1)!, 440);
      assert.equal(b.gw.status, "backoff");
      await waitFor(() => b.sockets.length === n + 1);
    }
    close(b.sockets.at(-1)!, 440);
    assert.equal(b.gw.status, "replaced");
    assert.equal(b.authIntact(), true);
    await b.gw.stop();
  });

  it("SIGTERM / stop oturum dosyalarına dokunmaz", async () => {
    const { gw, authIntact } = setup();
    await gw.start();
    await gw.stop();
    assert.equal(authIntact(), true);
  });
});

describe("tek kopya (kilit)", () => {
  it("kilit başkasındaysa WhatsApp'a bağlanılmaz; kilit boşalınca bağlanır", async () => {
    const lease = new FakeLease();
    lease.answers = [false, false, true];
    const { gw, sockets } = setup({ lease });
    await gw.start();
    assert.equal(gw.status, "lease_wait");
    assert.equal(sockets.length, 0);
    assert.equal(gw.health().ok, false);
    await waitFor(() => sockets.length === 1);
    assert.equal(lease.calls, 3);
    await gw.stop();
  });

  it("kilidi tutmayan kopya bağlantı satırına heartbeat yazmaz (çalışan kopyanın durumunu ezmez)", async () => {
    const lease = new FakeLease();
    lease.answers = [false];
    const { gw, st } = setup({ lease, timing: { ...FAST, leaseRetryMs: 10_000_000 } });
    await gw.start();
    assert.equal(gw.status, "lease_wait");
    await gw.stop();
    assert.deepEqual(st.hb, []);
  });

  it("kilit hatası (veritabanı yok) yeniden denenir", async () => {
    const lease = new FakeLease();
    lease.answers = [new Error("ECONNREFUSED")];
    const { gw, sockets } = setup({ lease });
    await gw.start();
    assert.equal(gw.status, "backoff");
    await waitFor(() => sockets.length === 1);
    await gw.stop();
  });

  it("kilit kaybedilince soket HEMEN kapanır; kilit yeniden alınınca bağlanır", async () => {
    const lease = new FakeLease();
    const { gw, sockets, live } = setup({ lease });
    await gw.start();
    open(sockets[0]!);
    await waitFor(() => gw.status === "open");
    lease.answers = [false, true];
    lease.lose();
    assert.equal(sockets[0]!.ended, true);
    assert.equal(live().length, 0);
    assert.equal(gw.status, "lease_wait");
    await waitFor(() => sockets.length === 2);
    assert.equal(live().length, 1);
    await gw.stop();
  });
});

describe("watchdog", () => {
  const clock = () => {
    let t = 1_000_000_000;
    return { now: () => t, add: (ms: number) => (t += ms) };
  };

  it("kurtarılabilir durumda 10 dk açılmazsa bir kez çıkış ister; geçmişe yazar; oturuma dokunmaz", async () => {
    const c = clock();
    const file = path.join(tmpService(), "wd.json");
    const history = new RestartHistory(file);
    let fired = 0;
    const { gw, sockets, authIntact } = setup({
      now: c.now,
      history,
      onWatchdog: () => (fired += 1),
      timing: { ...FAST, backoffBaseMs: 10_000_000, backoffCapMs: 10_000_000 },
    });
    assert.equal(gw.watchdogWindowMs, 10 * 60_000);
    await gw.start();
    close(sockets[0]!, 428);
    c.add(9 * 60_000);
    gw.watchdogTick();
    assert.equal(fired, 0);
    c.add(2 * 60_000);
    gw.watchdogTick();
    gw.watchdogTick();
    assert.equal(fired, 1);
    assert.equal(history.read().length, 1);
    assert.equal(authIntact(), true);
    await gw.stop();
  });

  it("yeniden başlatma döngüsünde pencere uzar; sürekli açık kalınca geçmiş temizlenir", async () => {
    const c = clock();
    const file = path.join(tmpService(), "wd.json");
    const history = new RestartHistory(file);
    history.record(c.now() - 60_000);
    history.record(c.now() - 30_000);
    const { gw, sockets } = setup({ now: c.now, history });
    assert.equal(gw.watchdogWindowMs, 40 * 60_000);
    await gw.start();
    open(sockets[0]!);
    await waitFor(() => gw.status === "open");
    c.add(41 * 60_000);
    gw.watchdogTick();
    assert.deepEqual(history.read(), []);
    await gw.stop();
  });

  it("QR, needs_qr, blocked, replaced ve kilit beklemesinde çalışmaz", async () => {
    const c = clock();
    let fired = 0;
    const lease = new FakeLease();
    lease.answers = [false];
    const { gw } = setup({
      now: c.now,
      lease,
      onWatchdog: () => (fired += 1),
      timing: { ...FAST, leaseRetryMs: 10_000_000 },
    });
    await gw.start();
    assert.equal(gw.status, "lease_wait");
    c.add(120 * 60_000);
    gw.watchdogTick();
    assert.equal(fired, 0);
    await gw.stop();

    const d = setup({ now: c.now, onWatchdog: () => (fired += 1) });
    await d.gw.start();
    close(d.sockets[0]!, 401);
    c.add(120 * 60_000);
    d.gw.watchdogTick();
    assert.equal(fired, 0);
    await d.gw.stop();
  });
});

describe("sağlık kontrolü gerçek bağlantıyı yansıtır", () => {
  it("açık: ok; kısa yeniden bağlanma: ok; uzun: 503; ilk QR: ok + dikkat", async () => {
    const c = { t: 5_000_000 };
    const { gw, sockets } = setup({
      now: () => c.t,
      timing: { ...FAST, backoffBaseMs: 10_000_000, backoffCapMs: 10_000_000 },
    });
    await gw.start();
    sockets[0]!.ev.emit("connection.update", { qr: "2@gizli" });
    assert.deepEqual([gw.health().ok, gw.health().attention], [true, true]);
    open(sockets[0]!);
    await waitFor(() => gw.status === "open");
    assert.deepEqual(
      [gw.health().ok, gw.health().connected, gw.health().notOpenSec],
      [true, true, null],
    );
    close(sockets[0]!, 428);
    c.t += 500;
    assert.equal(gw.health().ok, true);
    c.t += 2_000;
    assert.equal(gw.health().ok, false);
    assert.equal(gw.health().notOpenSec, 3);
    await gw.stop();
  });
});

describe("protokol sürümü sabit", () => {
  it("varsayılan: kurulu Baileys sürümü (soket üreticisine sürüm verilmez); ağdan çekilmez", async () => {
    const { gw, versions } = setup();
    assert.match(gw.protocolVersion, /^\d+\.\d+\.\d+$/);
    await gw.start();
    assert.deepEqual(versions, [null]);
    await gw.stop();
    const src = fs.readFileSync(new URL("../src/session.ts", import.meta.url), "utf8");
    assert.equal(src.includes("fetchLatestBaileysVersion"), false);
  });

  it("WA_PROTOCOL_VERSION ile kontrollü geçersiz kılma; geçersiz biçim reddedilir", async () => {
    const { gw, versions } = setup({ env: { WA_PROTOCOL_VERSION: "2.3000.1000000001" } });
    await gw.start();
    assert.deepEqual(versions, [[2, 3000, 1000000001]]);
    assert.equal(gw.protocolVersion, "2.3000.1000000001");
    await gw.stop();
    assert.throws(
      () =>
        loadConfig({ WA_ALLOWED_NUMBER: "905321112233", WA_PROTOCOL_VERSION: "latest" }, "/tmp/x"),
      /WA_PROTOCOL_VERSION/,
    );
  });
});

describe("mesajlar veritabanına yazılamazsa kaybolmaz", () => {
  const GROUP = "120363025555555555@g.us";
  const msg = (id: string): WAMessage =>
    ({
      key: { remoteJid: GROUP, id, fromMe: false, participant: "905329998877@s.whatsapp.net" },
      message: { conversation: "Villa Mavi 12-18 Temmuz kapalı" },
      messageTimestamp: 1_784_000_000,
    }) as WAMessage;
  const upsert = (s: FakeSock, m: WAMessage) =>
    s.ev.emit("messages.upsert", { messages: [m], type: "notify" });

  it("kısa hata: yeniden denenir ve bir kez kaydedilir", async () => {
    const { gw, sockets, st } = setup();
    await gw.start();
    open(sockets[0]!);
    st.fail(2);
    upsert(sockets[0]!, msg("A1"));
    await waitFor(() => st.ingested.length === 1);
    assert.equal(gw.stats.ingestRetried, 1);
    assert.equal(gw.pendingCount, 0);
    await gw.stop();
  });

  it("uzun hata: bellekte bekler, aynı mesaj tekrar gelirse çoğalmaz, veritabanı dönünce yazılır", async () => {
    const { gw, sockets, st } = setup();
    await gw.start();
    open(sockets[0]!);
    await waitFor(() => gw.status === "open");
    st.fail(4);
    upsert(sockets[0]!, msg("B1"));
    await waitFor(() => gw.pendingCount === 1);
    assert.equal(st.ingested.length, 0);
    assert.ok(gw.events.some((e) => e.kind === "error" && /bekletiliyor/.test(e.text)));
    assert.deepEqual(st.hb.length > 0, true);
    upsert(sockets[0]!, msg("B1"));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(gw.pendingCount, 1);
    await gw.flushPending();
    assert.equal(gw.pendingCount, 0);
    assert.equal(st.ingested.length, 1);
    upsert(sockets[0]!, msg("B1"));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(st.ingested.length, 1);
    await gw.stop();
  });

  it("kuyruk sınırı aşılırsa düşürülen mesaj sayılır ve hata olarak yazılır (sessiz değil)", async () => {
    const { gw, sockets, st } = setup();
    await gw.start();
    open(sockets[0]!);
    st.fail(1_000);
    for (const id of ["C1", "C2", "C3", "C4"]) upsert(sockets[0]!, msg(id));
    await waitFor(() => gw.stats.ingestDropped === 1);
    assert.equal(gw.pendingCount, 3);
    st.fail(0);
    await gw.stop(); // kapanışta bekleyenler yazılır
    assert.equal(st.ingested.length, 3);
  });

  it("çözülemeyen mesaj yer tutucusu sayılır; içerik yok", async () => {
    const { gw, sockets } = setup();
    await gw.start();
    sockets[0]!.ev.emit("messages.upsert", {
      messages: [
        { key: { remoteJid: GROUP, id: "Z" }, messageStubType: 2 } as unknown as WAMessage,
      ],
      type: "notify",
    });
    assert.equal(gw.stats.undecryptable, 1);
    await gw.stop();
  });
});

describe("heartbeat kapanma nedenini taşır", () => {
  it("close_428 ve open", async () => {
    const { gw, sockets, st } = setup();
    await gw.start();
    open(sockets[0]!);
    await waitFor(() => gw.status === "open");
    assert.deepEqual(st.hb.at(-1), ["open", null]);
    close(sockets[0]!, 428);
    assert.deepEqual(st.hb.at(-1), ["closed", "close_428"]);
    for (const [, code] of st.hb) if (code) assert.match(code, /^[a-z0-9_]{1,40}$/);
    await gw.stop();
    assert.deepEqual(st.hb.at(-1), ["closed", "stopped"]);
  });
});
