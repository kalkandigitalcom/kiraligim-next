import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WAMessage, WASocket } from "baileys";

import { loadConfig } from "../src/config.ts";
import type { GroupMetaLike } from "../src/groups.ts";
import { WaGateway } from "../src/session.ts";
import type { InboundRecord, WaStore } from "../src/store.ts";

const GROUP = "120363025555555555@g.us";

type SyncCall = {
  jid: string;
  present: boolean;
  addedByPn?: string | null;
  ownerPn?: string | null;
};

function fakeStore(verify = "verified", ingest = "stored") {
  const calls = {
    verify: [] as [string, string | null][],
    ingest: [] as InboundRecord[],
    sync: [] as SyncCall[],
  };
  const store = {
    async heartbeat() {
      return "c1";
    },
    async syncGroup(g: SyncCall) {
      calls.sync.push(g);
      return "discovered";
    },
    async verifyPhone(code: string, pn: string | null) {
      calls.verify.push([code, pn]);
      return verify;
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

function fakeSock(lidMap: Record<string, string> = {}, meta?: GroupMetaLike) {
  const sent: { jid: string; content: unknown }[] = [];
  const sock = {
    user: { id: "905321112233:7@s.whatsapp.net", lid: "999000999000:7@lid" },
    signalRepository: { lidMapping: { getPNForLID: async (lid: string) => lidMap[lid] ?? null } },
    async sendMessage(jid: string, content: unknown) {
      sent.push({ jid, content });
      return { key: { id: "R1" } };
    },
    async groupMetadata() {
      return meta;
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

const dm = (id: string, text: string, from = "905329998877@s.whatsapp.net", alt?: string) =>
  ({
    key: { remoteJid: from, remoteJidAlt: alt, id, fromMe: false },
    message: { conversation: text },
    messageTimestamp: 1_784_000_000,
  }) as WAMessage;

const config = loadConfig(
  { WA_ALLOWED_NUMBER: "905321112233", WA_DATABASE_URL: "postgres://u:p@localhost/lodging_dev" },
  "/tmp",
);

// Özel yöntemler; akışı ağsız denetlemek için doğrudan çağrılır.
type Internals = {
  onMessage(s: WASocket, m: WAMessage, b: boolean): Promise<void>;
  onDirectMessage(s: WASocket, m: WAMessage): Promise<void>;
  syncGroup(s: WASocket, meta: GroupMetaLike, present?: boolean): Promise<void>;
  refreshGroup(
    s: WASocket,
    jid: string,
    addedBy?: { pn: string | null; lid: string | null },
  ): Promise<void>;
};
const internals = (gw: WaGateway) => gw as unknown as Internals;
const deliver = (gw: WaGateway, sock: WASocket, m: WAMessage, backlog = false) =>
  internals(gw).onMessage(sock, m, backlog);
const deliverDm = (gw: WaGateway, sock: WASocket, m: WAMessage) =>
  internals(gw).onDirectMessage(sock, m);

describe("numara doğrulama (asistana özel mesaj)", () => {
  it("geçerli kod → doğrulama, yalnız başarıda o mesaja ✅ (tek dışa yazım)", async () => {
    const { store, calls } = fakeStore("verified");
    const { sock, sent } = fakeSock();
    const gw = new WaGateway(config, store);
    await deliverDm(gw, sock, dm("D1", "kiraligim doğrula 7Q4M-2XKD"));
    assert.deepEqual(calls.verify, [["7Q4M2XKD", "905329998877"]]);
    assert.equal(calls.ingest.length, 0, "özel mesaj kuyruğa yazılmaz");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.jid, "905329998877@s.whatsapp.net");
    assert.equal((sent[0]!.content as { react: { text: string } }).react.text, "✅");
    assert.equal(gw.stats.verified, 1);
  });

  for (const outcome of ["invalid", "sender_unknown"]) {
    it(`kod kabul edilmezse (${outcome}) tepki yok`, async () => {
      const { store } = fakeStore(outcome);
      const { sock, sent } = fakeSock();
      const gw = new WaGateway(config, store);
      await deliverDm(gw, sock, dm("D2", "kiraligim doğrula 7Q4M-2XKD"));
      assert.equal(sent.length, 0);
      assert.equal(gw.stats.rejectedCodes, 1);
    });
  }

  it("gizli kimlikle (LID) gelen özel mesajda numara alternatif JID'den ya da eşleme tablosundan", async () => {
    const { store, calls } = fakeStore();
    const { sock } = fakeSock({ "1234567890123@lid": "905321110000@s.whatsapp.net" });
    const gw = new WaGateway(config, store);
    await deliverDm(gw, sock, dm("D3", "kiraligim doğrula 7Q4M-2XKD", "1234567890123@lid"));
    await deliverDm(
      gw,
      sock,
      dm("D4", "kiraligim 7Q4M-2XKE", "5555555555555@lid", "905324440000@s.whatsapp.net"),
    );
    assert.deepEqual(calls.verify, [
      ["7Q4M2XKD", "905321110000"],
      ["7Q4M2XKE", "905324440000"],
    ]);
  });

  it("kod olmayan özel mesaj hiçbir yere yazılmaz, yanıtlanmaz; aynı mesaj bir kez işlenir", async () => {
    const { store, calls } = fakeStore();
    const { sock, sent } = fakeSock();
    const gw = new WaGateway(config, store);
    await deliverDm(gw, sock, dm("D5", "Merhaba, villa müsait mi?"));
    await deliverDm(gw, sock, dm("D6", "kiraligim doğrula 7Q4M-2XKD"));
    await deliverDm(gw, sock, dm("D6", "kiraligim doğrula 7Q4M-2XKD"));
    assert.equal(calls.verify.length, 1);
    assert.equal(calls.ingest.length, 0);
    assert.equal(sent.length, 1);
  });
});

describe("gruba kod yazılmaz (kodsuz eşleştirme)", () => {
  it("gruptaki eski biçimli kod normal mesaj gibi davranır: doğrulama yok, tepki yok", async () => {
    const { store, calls } = fakeStore();
    const { sock, sent } = fakeSock();
    const gw = new WaGateway(config, store);
    await deliver(gw, sock, msg("M1", "kiraligim 7Q4M-2XKD"));
    assert.equal(calls.verify.length, 0);
    assert.equal(calls.ingest.length, 1, "veritabanı yalnız bağlı grupta saklar");
    assert.equal(sent.length, 0);
  });
});

describe("grup keşfi: ekleyen kişi ve kurucu", () => {
  const meta: GroupMetaLike = {
    id: GROUP,
    subject: "Villa Defne",
    owner: "222@lid",
    participants: [
      { id: "999000999000@lid", admin: null },
      { id: "222@lid", admin: "superadmin" },
    ],
  };

  it("katılım bildirimi (groups.upsert): ekleyen ve kurucu numaraları iletilir, LID çözülür", async () => {
    const { store, calls } = fakeStore();
    const { sock } = fakeSock({ "222@lid": "905320000001@s.whatsapp.net" });
    const gw = new WaGateway(config, store);
    await internals(gw).syncGroup(sock, {
      ...meta,
      author: "333@lid",
      authorPn: "905320000002@s.whatsapp.net",
    });
    assert.equal(calls.sync.length, 1);
    assert.equal(calls.sync[0]!.addedByPn, "905320000002");
    assert.equal(calls.sync[0]!.ownerPn, "905320000001");
    assert.equal(calls.sync[0]!.present, true);
  });

  it("katılımcı olayı (add): ekleyen olayın author'undan; toplu listede ekleyen boş", async () => {
    const { store, calls } = fakeStore();
    const { sock } = fakeSock({ "444@lid": "905320000003@s.whatsapp.net" }, meta);
    const gw = new WaGateway(config, store);
    await internals(gw).refreshGroup(sock, GROUP, { pn: null, lid: "444@lid" });
    await internals(gw).syncGroup(sock, meta);
    assert.equal(calls.sync[0]!.addedByPn, "905320000003");
    assert.equal(calls.sync[1]!.addedByPn, null);
    assert.equal(calls.sync[1]!.ownerPn, null, "eşleme yoksa numara uydurulmaz");
  });
});

describe("A1 mesaj kaydı (değişmedi)", () => {
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

  it("kesinti sonrası birikim 'backlog' olarak kaydedilir", async () => {
    const { store, calls } = fakeStore();
    const { sock, sent } = fakeSock();
    const gw = new WaGateway(config, store);
    await deliver(gw, sock, msg("M4", "eski mesaj"), true);
    assert.equal(calls.ingest[0]?.kind, "backlog");
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
    const { sock } = fakeSock({ "1234567890123@lid": "905321110000@s.whatsapp.net" });
    const gw = new WaGateway(config, store);
    await deliver(gw, sock, msg("M7", "selam", "1234567890123@lid"));
    assert.equal(calls.ingest[0]?.senderPn, "905321110000");
  });

  it("bağlı olmayan grubun mesajı ('ignored') sayılır, tepki yok", async () => {
    const { store } = fakeStore("verified", "ignored");
    const { sock, sent } = fakeSock();
    const gw = new WaGateway(config, store);
    await deliver(gw, sock, msg("M8", "selam"));
    assert.equal(gw.stats.ignored, 1);
    assert.equal(sent.length, 0);
  });
});
