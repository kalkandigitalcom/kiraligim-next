import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WAMessage } from "baileys";

import { extractGroupMessage, istanbulTime, maskNumber, numberFromJid } from "../src/extract.ts";

const GROUP = "120363025555555555@g.us";
const TEXT = "Villa Zeytin'in 10-15 Temmuz tarihlerini kapat.";
const TS = 1_784_000_000; // saniye

const msg = (over: Partial<WAMessage> & { key?: Partial<WAMessage["key"]> } = {}): WAMessage =>
  ({
    key: {
      remoteJid: GROUP,
      id: "3EB0A1B2C3D4E5F6",
      fromMe: false,
      participant: "905321112233@s.whatsapp.net",
      ...over.key,
    },
    message: over.message ?? { conversation: TEXT },
    messageTimestamp: over.messageTimestamp ?? TS,
  }) as WAMessage;

describe("grup mesajı çıkarma", () => {
  it("test senaryosu: grup, gönderen, mesaj kimliği, içerik, zaman", () => {
    assert.deepEqual(extractGroupMessage(msg()), {
      groupJid: GROUP,
      messageId: "3EB0A1B2C3D4E5F6",
      senderJid: "905321112233@s.whatsapp.net",
      senderNumber: "905321112233",
      senderLid: null,
      text: TEXT,
      sentAt: new Date(TS * 1000).toISOString(),
    });
  });

  it("gönderen gizli kimlikle (LID) gelirse telefon participantAlt'tan alınır", () => {
    const m = extractGroupMessage(
      msg({
        key: { participant: "1234567890123@lid", participantAlt: "905321112233@s.whatsapp.net" },
      }),
    );
    assert.equal(m?.senderNumber, "905321112233");
    assert.equal(m?.senderLid, "1234567890123@lid");
  });

  it("yalnız LID varsa telefon null, LID saklanır", () => {
    const m = extractGroupMessage(msg({ key: { participant: "1234567890123@lid" } }));
    assert.equal(m?.senderNumber, null);
    assert.equal(m?.senderJid, "1234567890123@lid");
  });

  it("uzun metin ve geçici (ephemeral) mesaj sarmalı okunur", () => {
    assert.equal(
      extractGroupMessage(msg({ message: { extendedTextMessage: { text: TEXT } } }))?.text,
      TEXT,
    );
    assert.equal(
      extractGroupMessage(
        msg({ message: { ephemeralMessage: { message: { conversation: TEXT } } } }),
      )?.text,
      TEXT,
    );
  });

  it("kendi mesajı, bire bir sohbet, tepki, protokol ve boş mesaj yok sayılır", () => {
    assert.equal(extractGroupMessage(msg({ key: { fromMe: true } })), null);
    assert.equal(
      extractGroupMessage(msg({ key: { remoteJid: "905321112233@s.whatsapp.net" } })),
      null,
    );
    assert.equal(
      extractGroupMessage(msg({ message: { reactionMessage: { text: "✅", key: { id: "x" } } } })),
      null,
    );
    assert.equal(extractGroupMessage(msg({ message: { protocolMessage: { type: 0 } } })), null);
    assert.equal(extractGroupMessage(msg({ message: { conversation: "   " } })), null);
    assert.equal(extractGroupMessage(msg({ key: { id: "" } })), null);
  });
});

describe("yardımcılar", () => {
  it("numara JID'den çıkarılır, cihaz eki atılır; LID numara değildir", () => {
    assert.equal(numberFromJid("905321112233:12@s.whatsapp.net"), "905321112233");
    assert.equal(numberFromJid("1234567890123@lid"), null);
    assert.equal(numberFromJid(undefined), null);
  });

  it("numara maskelenir", () => {
    assert.equal(maskNumber("905321112233"), "+90 532 *** ** 33");
    assert.equal(maskNumber(null), "bilinmiyor");
  });

  it("zaman Europe/Istanbul'da gösterilir", () => {
    assert.match(istanbulTime("2026-07-01T09:00:00.000Z"), /12:00:00/);
  });
});
