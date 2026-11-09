import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseLinkMessage, selfIds, selfRemoved, toGroupSync } from "../src/groups.ts";

/** Aynı vektörler tests/unit/whatsapp-meta.test.ts içinde de denetlenir (iki kopya uyumlu kalmalı). */
export const LINK_VECTORS: [string, string | null][] = [
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

describe("bağlama kodu mesajı", () => {
  it("yalnız mesajın tamamı kod ise tanınır", () => {
    for (const [text, expected] of LINK_VECTORS)
      assert.equal(parseLinkMessage(text), expected, text);
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
});
