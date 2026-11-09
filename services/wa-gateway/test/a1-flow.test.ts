import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WAMessage, WASocket } from "baileys";

import { loadConfig } from "../src/config.ts";
import { WaGateway } from "../src/session.ts";
import type { InboundRecord, WaStore } from "../src/store.ts";

const GROUP = "120363025555555555@g.us";

function fakeStore(redeem = "linked", ingest = "stored") {
  const calls = {
    redeem: [] as [string, string, string | null][],
    ingest: [] as InboundRecord[],
  };
  const store = {
    async heartbeat() {
      return "c1";
    },
    async syncGroup() {
      return "discovered";
    },
    async redeemLinkCode(jid: string, code: string, pn: string | null) {
      calls.redeem.push([jid, code, pn]);
      return redeem;
    },
    async ingest(m: InboundRecord) {
      calls.ingest.push(m);
      return ingest;
    },
    async purge() {
      return 0;
    },
  };
  return { store: store as unknown as WaStore, calls };
}

function fakeSock(pnForLid: string | null = null) {
  const sent: { jid: string; content: unknown }[] = [];
  const sock = {
    user: { id: "905321112233:7@s.whatsapp.net" },
    signalRepository: { lidMapping: { getPNForLID: async () => pnForLid } },
    async sendMessage(jid: string, content: unknown) {
      sent.push({ jid, content });
      return { key: { id: "R1" } };
    },
  };
  return { sock: sock as unknown as WASocket, sent };
}

const msg = (id: string, text: string, participant = "905329998877@s.whatsapp.net"): WAMessage =>
  ({
    key: { remoteJid: GROUP, id, fromMe: false, participant },
    message: { conversation: text },
    messageTimestamp: 1_784_000_000,
  }) as WAMessage;

const config = loadConfig(
  { WA_ALLOWED_NUMBER: "905321112233", WA_DATABASE_URL: "postgres://u:p@localhost/lodging_dev" },
  "/tmp",
);

// onMessage özeldir; akışı ağsız denetlemek için doğrudan çağrılır.
const deliver = (gw: WaGateway, sock: WASocket, m: WAMessage, backlog = false) =>
  (
    gw as unknown as {
      onMessage(s: WASocket, m: WAMessage, b: boolean): Promise<void>;
    }
  ).onMessage(sock, m, backlog);

describe("A1 mesaj akışı (ağsız)", () => {
  it("geçerli bağlama kodu → doğrulama, yalnız başarıda ✅ (tek dışa yazım)", async () => {
    const { store, calls } = fakeStore("linked");
    const { sock, sent } = fakeSock();
    const gw = new WaGateway(config, store);
    await deliver(gw, sock, msg("M1", "kiraligim 7Q4M-2XKD"));
    assert.deepEqual(calls.redeem, [[GROUP, "7Q4M2XKD", "905329998877"]]);
    assert.equal(calls.ingest.length, 0, "kod mesajı kuyruğa yazılmaz");
    assert.equal(sent.length, 1);
    assert.deepEqual((sent[0]!.content as { react: { text: string } }).react.text, "✅");
    assert.equal(gw.stats.linked, 1);
  });

  for (const outcome of [
    "invalid",
    "sender_mismatch",
    "sender_unknown",
    "throttled",
    "linked_elsewhere",
  ]) {
    it(`kod kabul edilmezse (${outcome}) tepki yok`, async () => {
      const { store } = fakeStore(outcome);
      const { sock, sent } = fakeSock();
      const gw = new WaGateway(config, store);
      await deliver(gw, sock, msg("M2", "kiraligim 7Q4M-2XKD"));
      assert.equal(sent.length, 0);
      assert.equal(gw.stats.rejectedCodes, 1);
    });
  }

  it("normal mesaj kuyruğa (canlı), tepki yok; içerik ve gönderen aktarılır", async () => {
    const { store, calls } = fakeStore();
    const { sock, sent } = fakeSock();
    const gw = new WaGateway(config, store);
    await deliver(gw, sock, msg("M3", "Villa Zeytin'in 10-15 Temmuz tarihlerini kapat."));
    assert.equal(sent.length, 0, "A1'de işlem ve tepki yok");
    assert.equal(calls.ingest.length, 1);
    assert.deepEqual(
      { ...calls.ingest[0], sentAt: undefined },
      {
        groupJid: GROUP,
        messageId: "M3",
        senderJid: "905329998877@s.whatsapp.net",
        senderPn: "905329998877",
        senderLid: null,
        body: "Villa Zeytin'in 10-15 Temmuz tarihlerini kapat.",
        sentAt: undefined,
        kind: "live",
      },
    );
  });

  it("kesinti sonrası birikim 'backlog' olarak kaydedilir; eski kod mesajı işlenmez", async () => {
    const { store, calls } = fakeStore();
    const { sock, sent } = fakeSock();
    const gw = new WaGateway(config, store);
    await deliver(gw, sock, msg("M4", "eski mesaj"), true);
    await deliver(gw, sock, msg("M5", "kiraligim 7Q4M-2XKD"), true);
    assert.equal(calls.ingest[0]?.kind, "backlog");
    assert.equal(calls.redeem.length, 0);
    assert.equal(sent.length, 0);
  });

  it("aynı mesaj ikinci kez gelirse veritabanına bir kez gider", async () => {
    const { store, calls } = fakeStore();
    const { sock } = fakeSock();
    const gw = new WaGateway(config, store);
    await deliver(gw, sock, msg("M6", "merhaba"));
    await deliver(gw, sock, msg("M6", "merhaba"));
    assert.equal(calls.ingest.length, 1);
  });

  it("gönderen gizli kimlikle (LID) gelirse numara eşleme tablosundan çözülür", async () => {
    const { store, calls } = fakeStore();
    const { sock } = fakeSock("905321110000@s.whatsapp.net");
    const gw = new WaGateway(config, store);
    await deliver(gw, sock, msg("M7", "kiraligim 7Q4M-2XKD", "1234567890123@lid"));
    assert.deepEqual(calls.redeem[0], [GROUP, "7Q4M2XKD", "905321110000"]);
  });

  it("bağlı olmayan grubun mesajı ('ignored') sayılır, tepki yok", async () => {
    const { store } = fakeStore("linked", "ignored");
    const { sock, sent } = fakeSock();
    const gw = new WaGateway(config, store);
    await deliver(gw, sock, msg("M8", "selam"));
    assert.equal(gw.stats.ignored, 1);
    assert.equal(sent.length, 0);
  });
});
