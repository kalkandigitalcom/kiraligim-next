import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, mock } from "node:test";

import type { AuthenticationState, WAMessage, WASocket } from "baileys";

import { loadConfig } from "../src/config.ts";
import {
  MessageDiagnostics,
  rawKind,
  shortJid,
  STALL_AFTER_MS,
  undecryptableKind,
} from "../src/diagnostics.ts";
import { explainDirectMessage, explainGroupMessage } from "../src/extract.ts";
import { statusJson } from "../src/server.ts";
import { WaGateway } from "../src/session.ts";
import type { InboundRecord, WaStore } from "../src/store.ts";

/**
 * Aşama 1.1 — mesaj alımı teşhisi. Dört katman ayrı sayılır: ham WebSocket paketi → Baileys
 * upsert → bizim filtre → veritabanı sonucu. Günlükte metin, numara ve tam grup kimliği yok.
 */
const GROUP = "120363411788827787@g.us";
const OTHER_GROUP = "120363025555555555@g.us";
const SENDER = "905329998877@s.whatsapp.net";
const SECRET_TEXT = "Villa Mavi 12-18 Temmuz kapalı gizli-metin";

type FakeSock = WASocket & { ev: EventEmitter; ws: EventEmitter; ended: boolean };

function fakeSocket(): FakeSock {
  const s = {
    ev: new EventEmitter(),
    ws: new EventEmitter(),
    ended: false,
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
    async sendMessage() {
      return undefined;
    },
  };
  return s as unknown as FakeSock;
}

function setup(opts: { trace?: boolean; failIngest?: number; now?: () => number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-diag-"));
  const config = loadConfig(
    {
      WA_ALLOWED_NUMBER: "905321112233",
      WA_DATABASE_URL: "postgres://u:p@localhost/lodging_dev",
      ...(opts.trace ? { WA_TRACE: "1" } : {}),
    },
    dir,
  );
  const ingested: InboundRecord[] = [];
  let failures = opts.failIngest ?? 0;
  const store = {
    async heartbeat() {
      return "c1";
    },
    async syncGroup() {
      return "linked";
    },
    async verifyPhone() {
      return "invalid";
    },
    async ingest(m: InboundRecord) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("db down");
      }
      ingested.push(m);
      return "stored";
    },
    async purge() {
      return 0;
    },
  } as unknown as WaStore;
  const sockets: FakeSock[] = [];
  const gw = new WaGateway(config, store, {
    makeSocket: () => {
      const s = fakeSocket();
      sockets.push(s);
      return s;
    },
    loadAuth: async () => ({
      state: { creds: {}, keys: {} } as unknown as AuthenticationState,
      saveCreds: async () => undefined,
    }),
    timing: {
      backoffBaseMs: 5,
      backoffCapMs: 10,
      heartbeatMs: 10_000_000,
      watchdogTickMs: 10_000_000,
      pendingRetryMs: 10_000_000,
      ingestRetryMs: [1, 1, 1],
    },
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { gw, sockets, ingested };
}

const raw = (s: FakeSock, from: string, id: string, offline = false) =>
  s.ws.emit("CB:message", {
    tag: "message",
    attrs: { from, id, participant: SENDER, ...(offline ? { offline: "1" } : {}) },
  });
const upsert = (s: FakeSock, messages: WAMessage[], type = "notify") =>
  s.ev.emit("messages.upsert", { messages, type });
const groupMsg = (id: string, over: Partial<WAMessage> = {}, keyOver: object = {}): WAMessage =>
  ({
    key: { remoteJid: GROUP, id, fromMe: false, participant: SENDER, ...keyOver },
    message: { conversation: SECRET_TEXT },
    messageTimestamp: 1_784_000_000,
    ...over,
  }) as WAMessage;
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("yardımcılar", () => {
  it("paket türü, kısa grup kimliği, çözülemeyen mesaj türü", () => {
    assert.equal(rawKind(GROUP), "group");
    assert.equal(rawKind(SENDER), "direct");
    assert.equal(rawKind("123@lid"), "direct");
    assert.equal(rawKind("status@broadcast"), "other");
    assert.equal(rawKind(undefined), "other");
    assert.equal(shortJid(GROUP), "…827787");
    assert.equal(undecryptableKind("No session record"), "no_session");
    assert.equal(undecryptableKind("Key used already or never filled"), "missing_keys");
    assert.equal(undecryptableKind("Message absent from node"), "no_message");
    assert.equal(undecryptableKind("Bad MAC"), "bad_mac");
    assert.equal(undecryptableKind("No SenderKeyRecord found for decryption"), "no_sender_key");
    assert.equal(undecryptableKind(undefined), "other");
  });

  it("filtre nedenleri: mevcut ayıklama kurallarıyla aynı sonuç, nedeniyle", () => {
    const r = (m: WAMessage) => {
      const x = explainGroupMessage(m);
      return x.ok ? "ok" : x.reason;
    };
    assert.equal(r(groupMsg("a")), "ok");
    assert.equal(r(groupMsg("a", {}, { fromMe: true })), "from_me");
    assert.equal(r(groupMsg("a", {}, { remoteJid: SENDER })), "not_group");
    assert.equal(r(groupMsg("", {})), "no_key");
    assert.equal(
      r(groupMsg("a", { message: { reactionMessage: { text: "✅" } } } as never)),
      "reaction",
    );
    assert.equal(
      r(groupMsg("a", { message: { protocolMessage: { type: 0 } } } as never)),
      "protocol",
    );
    const sticker = explainGroupMessage(
      groupMsg("a", { message: { stickerMessage: {} } } as never),
    );
    assert.deepEqual(sticker, { ok: false, reason: "non_text", contentType: "stickerMessage" });
    assert.equal(
      r(
        groupMsg("a", {
          message: undefined,
          messageStubType: 2,
          messageStubParameters: ["No session"],
        } as never),
      ),
      "ciphertext",
    );
    assert.equal(r(groupMsg("a", { message: undefined, messageStubType: 27 } as never)), "stub");
    assert.equal(r(groupMsg("a", {}, { participant: undefined })), "no_sender");
    const dm = explainDirectMessage({
      key: { remoteJid: SENDER, id: "d", fromMe: false },
      message: { conversation: "merhaba" },
    } as WAMessage);
    assert.equal(dm.ok, true);
  });
});

describe("dört katman ayrı sayılır", () => {
  it("ham paket → upsert → kabul → kayıt; grup bazında", async () => {
    const { gw, sockets, ingested } = setup();
    await gw.start();
    const s = sockets[0]!;
    s.ev.emit("connection.update", { connection: "open" });
    raw(s, GROUP, "M1");
    raw(s, "status@broadcast", "S1");
    s.ws.emit("frame", {});
    upsert(s, [groupMsg("M1")]);
    await tick();
    const d = gw.diag.snapshot();
    assert.equal(d.raw.message, 2);
    assert.equal(d.raw.group, 1);
    assert.equal(d.raw.other, 1);
    assert.ok(d.raw.lastFrameAt);
    assert.equal(d.upsert.notify, 1);
    assert.equal(d.processing.accepted, 1);
    assert.equal(d.processing.stored, 1);
    assert.equal(ingested.length, 1);
    const g = d.groups.find((x) => x.jid === GROUP)!;
    assert.deepEqual(
      [g.raw, g.upsert, g.accepted, g.stored, g.lastDecision],
      [1, 1, 1, 1, "stored"],
    );
    assert.equal(d.stallSuspected, false);
    assert.equal(d.socket.generation > 0, true);
    assert.ok(d.socket.openAt);
    await gw.stop();
  });

  it("filtre nedenleri ve çözülemeyen mesajlar ayrı sayaçlarda", async () => {
    const { gw, sockets, ingested } = setup();
    await gw.start();
    const s = sockets[0]!;
    upsert(s, [
      groupMsg("F1", {}, { fromMe: true }),
      groupMsg("F2", { message: { reactionMessage: { text: "✅" } } } as never),
      groupMsg("F3", { message: { stickerMessage: {} } } as never),
      groupMsg("F4", {
        message: undefined,
        messageStubType: 2,
        messageStubParameters: ["No session record found"],
      } as never),
      groupMsg("F5", {}, { participant: undefined }),
    ]);
    upsert(s, [groupMsg("OK1")]);
    await tick();
    upsert(s, [groupMsg("OK1")]); // aynı mesaj tekrar
    await tick();
    const d = gw.diag.snapshot();
    assert.equal(d.filtered.from_me, 1);
    assert.equal(d.filtered.reaction, 1);
    assert.equal(d.filtered.non_text, 1);
    assert.deepEqual(d.nonTextTypes, { stickerMessage: 1 });
    assert.equal(d.filtered.ciphertext, 1);
    assert.equal(d.undecryptable.no_session, 1);
    assert.equal(gw.stats.undecryptable, 1);
    assert.equal(d.filtered.no_sender, 1);
    assert.equal(d.filtered.duplicate, 1);
    assert.equal(d.processing.stored, 1);
    assert.equal(ingested.length, 1);
    await gw.stop();
  });

  it("işlenmeyen upsert türü ve eski soket olayı ayrı sayılır, işlenmez", async () => {
    const { gw, sockets, ingested } = setup();
    await gw.start();
    const s = sockets[0]!;
    upsert(s, [groupMsg("T1")], "last");
    await tick();
    assert.equal(gw.diag.upsert.skippedType, 1);
    assert.equal(gw.diag.upsert.other, 1);
    // Soket kapanır; eski soketten geç gelen olaylar yok sayılır ve dinleyicileri kaldırılır.
    s.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    assert.equal(s.ws.listenerCount("CB:message"), 0);
    assert.equal(s.ws.listenerCount("frame"), 0);
    assert.equal(ingested.length, 0);
    await gw.stop();
  });

  it("veritabanı hatası: önce 'failed', kuyruktan yazılınca 'stored'", async () => {
    const { gw, sockets, ingested } = setup({ failIngest: 4 });
    await gw.start();
    const s = sockets[0]!;
    s.ev.emit("connection.update", { connection: "open" });
    upsert(s, [groupMsg("D1")]);
    await tick();
    assert.equal(gw.diag.processing.failed, 1);
    await gw.flushPending();
    assert.equal(gw.diag.processing.stored, 1);
    assert.equal(ingested.length, 1);
    await gw.stop();
  });

  it("özel mesajlar: elenen, doğrulama kodu olmayan, doğrulama kodu", async () => {
    const { gw, sockets } = setup();
    await gw.start();
    const s = sockets[0]!;
    const dm = (id: string, text: string, fromMe = false) =>
      ({ key: { remoteJid: SENDER, id, fromMe }, message: { conversation: text } }) as WAMessage;
    upsert(s, [dm("P1", "merhaba"), dm("P2", "x", true), dm("P3", "kiraligim doğrula 7Q4M-2XKD")]);
    await tick();
    assert.deepEqual(gw.diag.direct, { received: 3, filtered: 1, notCode: 1, verifyCodes: 1 });
    await gw.stop();
  });
});

describe("takılma şüphesi (yalnız uyarı)", () => {
  it("ham paket geldi, 2 dk upsert yok → bir kez uyarı; yeniden başlatma yok", async () => {
    let t = 1_000_000;
    const { gw, sockets } = setup({ now: () => t });
    await gw.start();
    const s = sockets[0]!;
    s.ev.emit("connection.update", { connection: "open" });
    raw(s, GROUP, "X1");
    t += STALL_AFTER_MS - 1;
    gw.watchdogTick();
    assert.equal(gw.diag.stallSuspected(), false);
    t += 2;
    gw.watchdogTick();
    gw.watchdogTick();
    assert.equal(gw.diag.stallSuspected(), true);
    assert.equal(gw.events.filter((e) => /takılmış olabilir/.test(e.text)).length, 1);
    assert.equal(gw.status, "open");
    assert.equal(s.ended, false);
    // upsert gelince şüphe kalkar.
    upsert(s, [groupMsg("X1")]);
    await tick();
    assert.equal(gw.diag.stallSuspected(), false);
    await gw.stop();
  });

  it("ham paket hiç gelmediyse şüphe yok (WebSocket'e ulaşmamış)", () => {
    const d = new MessageDiagnostics(() => 10_000_000, false);
    assert.equal(d.stallSuspected(), false);
  });
});

describe("gizlilik ve /status.json", () => {
  it("WA_TRACE=1: yalnız metadata; metin, numara ve tam grup kimliği yok", async (t) => {
    const lines: string[] = [];
    const spy = mock.method(console, "log", (...a: unknown[]) => lines.push(a.join(" ")));
    t.after(() => spy.mock.restore());
    const { gw, sockets } = setup({ trace: true });
    await gw.start();
    const s = sockets[0]!;
    s.ev.emit("connection.update", { connection: "open" });
    raw(s, GROUP, "TR1");
    raw(s, SENDER, "TR2");
    upsert(s, [groupMsg("TR1"), groupMsg("TR3", {}, { fromMe: true })]);
    upsert(s, [
      {
        key: { remoteJid: SENDER, id: "TR2", fromMe: false },
        message: { conversation: SECRET_TEXT },
      } as WAMessage,
    ]);
    await tick();
    await gw.stop();
    const trace = lines.filter((l) => l.startsWith("[wa-trace]"));
    assert.ok(trace.length >= 6, String(trace.length));
    const all = trace.join("\n");
    for (const secret of [SECRET_TEXT, "Villa Mavi", "905329998877", "120363411788827787", GROUP]) {
      assert.equal(all.includes(secret), false, secret);
    }
    assert.match(all, /ham paket tür=grup grp=…827787 id=TR1/);
    assert.match(all, /ham paket tür=özel id=TR2/);
    assert.match(all, /kayıt sonucu grp=…827787 id=TR1 sonuç=stored/);
    assert.match(all, /grup mesajı elendi .* neden=from_me/);
    assert.match(all, /özel mesaj karar=doğrulama_kodu_değil/);
  });

  it("WA_TRACE kapalıyken trace satırı yok; geçersiz değer reddedilir", async (t) => {
    const lines: string[] = [];
    const spy = mock.method(console, "log", (...a: unknown[]) => lines.push(a.join(" ")));
    t.after(() => spy.mock.restore());
    const { gw, sockets } = setup();
    await gw.start();
    raw(sockets[0]!, GROUP, "N1");
    await gw.stop();
    assert.equal(
      lines.some((l) => l.startsWith("[wa-trace]")),
      false,
    );
    assert.throws(
      () => loadConfig({ WA_ALLOWED_NUMBER: "905321112233", WA_TRACE: "yes" }, "/tmp/x"),
      /WA_TRACE/,
    );
  });

  it("/status.json teşhis bölümünü içerir; metin ve numara içermez", async () => {
    const { gw, sockets } = setup();
    await gw.start();
    const s = sockets[0]!;
    raw(s, OTHER_GROUP, "J1");
    upsert(s, [groupMsg("J2")]);
    await tick();
    const json = JSON.stringify(statusJson(gw, null));
    const parsed = JSON.parse(json) as {
      diagnostics: { raw: { group: number }; upsert: { notify: number } };
    };
    assert.equal(parsed.diagnostics.raw.group, 1);
    assert.equal(parsed.diagnostics.upsert.notify, 1);
    assert.equal(json.includes(SECRET_TEXT), false);
    assert.equal(json.includes("905329998877"), false);
    await gw.stop();
  });
});
