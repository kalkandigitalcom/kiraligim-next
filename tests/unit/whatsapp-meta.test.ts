import { describe, expect, it } from "vitest";

import {
  WA_CALENDAR_EXCERPT_MAX,
  WA_CALENDAR_FLAGS,
  WA_CALENDAR_MAX_ITEMS,
  WA_REVIEW_REASONS,
  type VillaResolution,
} from "@/lib/wa-calendar-parse";
import {
  WA_DECISION_MODES,
  WA_INBOUND_STATUSES,
  WA_PROPOSAL_LIMITS,
  WA_PROPOSAL_STATUSES,
  WA_VILLA_RESOLUTIONS,
  formatLinkCode,
  generateLinkCode,
  verifyMessage,
  waMeLink,
  maskPhone,
  normalizePhone,
  parseVerifyMessage,
  WA_LINK_CODE_ALPHABET,
  WA_LINK_CODE_LENGTH,
  WA_RETENTION_DAYS,
} from "@/lib/whatsapp-meta";

/**
 * WhatsApp Asistanı A1.1: numara doğrulama kodu biçimi (asistana özel mesaj). Vektörler
 * services/wa-gateway/test/groups.test.ts ile AYNIDIR (ağ geçidi kendi kopyasını denetler).
 */
const LINK_VECTORS: [string, string | null][] = [
  ["kiraligim doğrula 7Q4M-2XKD", "7Q4M2XKD"],
  ["Kiraligim Dogrula 7q4m2xkd", "7Q4M2XKD"],
  ["KİRALIĞIM DOĞRULA 7Q4M-2XKD", "7Q4M2XKD"],
  ["kiraligim dogrula7Q4M-2XKD", null],
  ["kiraligim doğrula", null],
  ["kiraligim 7Q4M-2XKD", "7Q4M2XKD"],
  ["  Kiraligim 7q4m2xkd ", "7Q4M2XKD"],
  ["KİRALIĞIM 7Q4M-2XKD", "7Q4M2XKD"],
  ["kiralığım abcd-efgh", "ABCDEFGH"],
  ["kiraligim 7Q4M-2XK0", null],
  ["kiraligim 7Q4M-2XKI", null],
  ["kiraligim 7Q4M-2XK", null],
  ["kod: kiraligim 7Q4M-2XKD", null],
  ["kiraligim 7Q4M-2XKD lütfen", null],
  ["Villa Zeytin'in 10-15 Temmuz tarihlerini kapat.", null],
];

describe("doğrulama kodu", () => {
  it("mesaj tanıma: yalnız mesajın tamamı kodsa", () => {
    for (const [text, expected] of LINK_VECTORS)
      expect(parseVerifyMessage(text), text).toBe(expected);
  });

  it("biçim ve gruba yazılacak mesaj geri ayrıştırılabilir", () => {
    expect(formatLinkCode("7Q4M2XKD")).toBe("7Q4M-2XKD");
    expect(verifyMessage("7Q4M2XKD")).toBe("kiraligim doğrula 7Q4M-2XKD");
    expect(parseVerifyMessage(verifyMessage("7Q4M2XKD"))).toBe("7Q4M2XKD");
  });

  it("üretilen kod alfabede ve 8 karakter; tüm bayt değerleri eşit dağılır", () => {
    expect(WA_LINK_CODE_ALPHABET).toHaveLength(32);
    expect(WA_LINK_CODE_ALPHABET).not.toMatch(/[01IO]/);
    const all = new Uint8Array(256).map((_, i) => i);
    let offset = 0;
    const counts = new Map<string, number>();
    for (let k = 0; k < 32; k++) {
      const code = generateLinkCode((n) => {
        const out = all.slice(offset, offset + n);
        offset += n;
        return out;
      });
      expect(code).toHaveLength(WA_LINK_CODE_LENGTH);
      expect(parseVerifyMessage(verifyMessage(code))).toBe(code);
      for (const c of code) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    expect([...counts.values()].every((n) => n === 8)).toBe(true);
  });

  it("saklama süresi 90 gün", () => {
    expect(WA_RETENTION_DAYS).toBe(90);
  });
});

describe("asistana özel mesaj bağlantısı", () => {
  it("wa.me bağlantısı yalnız geçerli numarayla; metin kodlanır", () => {
    expect(waMeLink("905350000000", "kiraligim doğrula 7Q4M-2XKD")).toBe(
      "https://wa.me/905350000000?text=kiraligim%20do%C4%9Frula%207Q4M-2XKD",
    );
    expect(waMeLink(null, "x")).toBeNull();
    expect(waMeLink("+90 535", "x")).toBeNull();
    expect(waMeLink("0535", "x")).toBeNull();
  });
});

describe("telefon", () => {
  it("normalize", () => {
    expect(normalizePhone("+90 532 111 22 33")).toBe("905321112233");
    expect(normalizePhone("0090 (532) 111-22-33")).toBe("905321112233");
    expect(normalizePhone("0532 111 22 33")).toBe("905321112233");
    expect(normalizePhone("+44 7700 900123")).toBe("447700900123");
    expect(normalizePhone("532")).toBeNull();
    expect(normalizePhone("+90 532 abc")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });

  it("maskeleme numarayı göstermez", () => {
    expect(maskPhone("905321112233")).toBe("+90 532 *** ** 33");
    expect(maskPhone(null)).toBe("gizli kimlik");
    expect(maskPhone("1234")).toBe("***");
  });
});

describe("takvim önerileri: veritabanı sınırlarıyla uyum (drizzle/0035)", () => {
  it("ayrıştırıcı sabitleri öneri tablosunun sınırlarıyla aynı", () => {
    expect(WA_PROPOSAL_LIMITS.itemsPerMessage).toBe(WA_CALENDAR_MAX_ITEMS);
    expect(WA_PROPOSAL_LIMITS.excerptMax).toBe(WA_CALENDAR_EXCERPT_MAX);
    const resolutions: readonly VillaResolution[] = WA_VILLA_RESOLUTIONS;
    expect([...resolutions].sort()).toEqual(["ambiguous", "named", "none", "single"]);
  });

  it("bayrak ve inceleme nedenleri tablodaki kısa kod biçimine uyar (^[a-z_]{1,40}$)", () => {
    for (const c of [...WA_CALENDAR_FLAGS, ...WA_REVIEW_REASONS]) {
      expect(c, c).toMatch(/^[a-z_]{1,40}$/);
    }
    // Sürüm 4 ile bayrak sözlüğü 20'yi aştı; tek bir öneride en fazla 20 bayrak saklanır ve sınır
    // aşılırsa işlemi engelleyen bayraklar korunur (wa-calendar-proposal.test.ts). Sözlük yine
    // sınırlı kalmalı.
    expect(WA_CALENDAR_FLAGS.length + 1).toBeLessThanOrEqual(2 * WA_PROPOSAL_LIMITS.arrayMax);
    expect(WA_REVIEW_REASONS.length).toBeLessThanOrEqual(WA_PROPOSAL_LIMITS.arrayMax);
  });

  it("kuyruk ve öneri durumları", () => {
    expect(WA_INBOUND_STATUSES).toEqual([
      "received",
      "processing",
      "processed",
      "ignored",
      "failed",
    ]);
    expect(WA_PROPOSAL_STATUSES).toContain("pending");
    expect(WA_DECISION_MODES).toEqual(["quick", "reviewed"]);
  });
});
