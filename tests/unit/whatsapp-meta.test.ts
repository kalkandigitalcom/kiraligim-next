import { describe, expect, it } from "vitest";

import {
  formatLinkCode,
  generateLinkCode,
  linkMessage,
  maskPhone,
  normalizePhone,
  parseLinkMessage,
  WA_LINK_CODE_ALPHABET,
  WA_LINK_CODE_LENGTH,
  WA_RETENTION_DAYS,
} from "@/lib/whatsapp-meta";

/**
 * WhatsApp Asistanı A1: bağlama kodu biçimi. Vektörler services/wa-gateway/test/groups.test.ts ile
 * AYNIDIR (ağ geçidi kendi kopyasını denetler).
 */
const LINK_VECTORS: [string, string | null][] = [
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

describe("bağlama kodu", () => {
  it("mesaj tanıma: yalnız mesajın tamamı kodsa", () => {
    for (const [text, expected] of LINK_VECTORS)
      expect(parseLinkMessage(text), text).toBe(expected);
  });

  it("biçim ve gruba yazılacak mesaj geri ayrıştırılabilir", () => {
    expect(formatLinkCode("7Q4M2XKD")).toBe("7Q4M-2XKD");
    expect(linkMessage("7Q4M2XKD")).toBe("kiraligim 7Q4M-2XKD");
    expect(parseLinkMessage(linkMessage("7Q4M2XKD"))).toBe("7Q4M2XKD");
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
      expect(parseLinkMessage(linkMessage(code))).toBe(code);
      for (const c of code) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    expect([...counts.values()].every((n) => n === 8)).toBe(true);
  });

  it("saklama süresi 90 gün", () => {
    expect(WA_RETENTION_DAYS).toBe(90);
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
