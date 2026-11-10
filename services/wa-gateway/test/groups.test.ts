import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  groupPeople,
  parseVerifyMessage,
  personOf,
  pnFromJid,
  selfAdded,
  selfIds,
  selfRemoved,
  toGroupSync,
} from "../src/groups.ts";

/** Aynı vektörler tests/unit/whatsapp-meta.test.ts içinde de denetlenir (iki kopya uyumlu kalmalı). */
export const VERIFY_VECTORS: [string, string | null][] = [
  ["kiraligim doğrula 7Q4M-2XKD", "7Q4M2XKD"],
  ["Kiraligim Dogrula 7q4m2xkd", "7Q4M2XKD"],
  ["KİRALIĞIM DOĞRULA 7Q4M-2XKD", "7Q4M2XKD"],
  ["kiraligim dogrula7Q4M-2XKD", null],
  ["kiraligim doğrula", null],
  ["kiraligim 7Q4M-2XKD", "7Q4M2XKD"],
  ["  Kiraligim 7q4m2xkd ", "7Q4M2XKD"],
  ["KİRALIĞIM 7Q4M-2XKD", "7Q4M2XKD"],
  ["kiralığım abcd-efgh", "ABCDEFGH"],
  ["kiraligim 7Q4M-2XK0", null], // 0 alfabede yok
  ["kiraligim 7Q4M-2XKI", null], // I alfabede yok
  ["kiraligim 7Q4M-2XK", null],
  ["kod: kiraligim 7Q4M-2XKD", null],
  ["kiraligim 7Q4M-2XKD lütfen", null],
  ["Villa Zeytin'in 10-15 Temmuz tarihlerini kapat.", null],
];

describe("numara doğrulama mesajı (asistana özel mesaj)", () => {
  it("yalnız mesajın tamamı kod ise tanınır; 'doğrula' isteğe bağlı", () => {
    for (const [text, expected] of VERIFY_VECTORS)
      assert.equal(parseVerifyMessage(text), expected, text);
  });
});

describe("grubu ekleyen kişi ve kurucu", () => {
  it("numara telefon JID'inden; gizli kimlik (LID) yalnız numara yoksa", () => {
    assert.equal(pnFromJid("905321112233:7@s.whatsapp.net"), "905321112233");
    assert.equal(pnFromJid("111222333444@lid"), null);
    assert.equal(pnFromJid(undefined), null);
    assert.deepEqual(personOf("111222333444@lid", "905329998877@s.whatsapp.net"), {
      pn: "905329998877",
      lid: null,
    });
    assert.deepEqual(personOf("111222333444:3@lid", undefined), {
      pn: null,
      lid: "111222333444@lid",
    });
    assert.deepEqual(personOf("905321110000@s.whatsapp.net", null), {
      pn: "905321110000",
      lid: null,
    });
    assert.deepEqual(personOf(undefined, undefined), { pn: null, lid: null });
  });

  it("katılım bildiriminde ekleyen (author) ve kurucu (owner) okunur", () => {
    assert.deepEqual(
      groupPeople({
        id: "120363025555555555@g.us",
        owner: "222@lid",
        ownerPn: "905320000001@s.whatsapp.net",
        author: "333@lid",
        authorPn: "905320000002@s.whatsapp.net",
      }),
      {
        addedBy: { pn: "905320000002", lid: null },
        owner: { pn: "905320000001", lid: null },
      },
    );
    // Toplu grup listesinde (katılım bildirimi değil) ekleyen bilinmez.
    assert.deepEqual(groupPeople({ id: "120363025555555555@g.us", owner: "444@lid" }).addedBy, {
      pn: null,
      lid: null,
    });
  });
});

describe("grup kaydı", () => {
  const self = selfIds({ id: "905321112233:7@s.whatsapp.net", lid: "111222333444:7@lid" });

  it("kendi kimlikleri cihaz eki olmadan", () => {
    assert.deepEqual(self, ["905321112233@s.whatsapp.net", "111222333444@lid"]);
  });

  it("yönetici ve 'yalnız yöneticiler yazar' bayrakları", () => {
    const g = toGroupSync(
      {
        id: "120363025555555555@g.us",
        subject: "  Zeytin – Ev sahibi  ",
        announce: true,
        participants: [
          { id: "111222333444@lid", admin: "admin" },
          { id: "905329998877@s.whatsapp.net", admin: null },
        ],
      },
      self,
    );
    assert.deepEqual(g, {
      jid: "120363025555555555@g.us",
      subject: "Zeytin – Ev sahibi",
      participants: 2,
      botIsAdmin: true,
      adminsOnly: true,
    });
  });

  it("yönetici değilse ve boyut verilmişse", () => {
    const g = toGroupSync(
      {
        id: "120363025555555555@g.us",
        subject: "",
        size: 12,
        participants: [{ id: "x@lid", phoneNumber: "905321112233@s.whatsapp.net", admin: null }],
      },
      self,
    );
    assert.equal(g.botIsAdmin, false);
    assert.equal(g.subject, null);
    assert.equal(g.participants, 12);
    assert.equal(g.adminsOnly, false);
  });

  it("gruptan çıkarılma yalnız kendi kimliğiyle ve 'remove' ile", () => {
    assert.equal(selfRemoved("remove", [{ id: "111222333444@lid" }], self), true);
    assert.equal(selfRemoved("remove", ["905321112233@s.whatsapp.net"], self), true);
    assert.equal(selfRemoved("remove", [{ id: "905329998877@s.whatsapp.net" }], self), false);
    assert.equal(selfRemoved("add", [{ id: "111222333444@lid" }], self), false);
  });

  it("gruba eklenme yalnız kendi kimliğiyle ve 'add' ile", () => {
    assert.equal(selfAdded("add", [{ id: "111222333444@lid" }], self), true);
    assert.equal(selfAdded("add", [{ id: "905329998877@s.whatsapp.net" }], self), false);
    assert.equal(selfAdded("promote", [{ id: "111222333444@lid" }], self), false);
  });
});
