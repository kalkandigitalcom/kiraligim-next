/**
 * Opsiyon Aşama 3c — Super Admin paneli saf yardımcıları ve sabitleri.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  durationInput,
  formatMinutes,
  formatRemaining,
  isUuid,
  parseCount,
  parseDurationChoices,
  parseDurationMinutes,
  parseGuestName,
  parseIsoDate,
  parseNote,
} from "@/lib/option-admin";
import { ADMIN_OPTION_ERRORS, OPTION_CONVERT_ENABLED } from "@/server/admin/options";

describe("süre ayrıştırma", () => {
  it("saat ve gün; 1 saat – 14 gün dışında geçersiz; boş null", () => {
    expect(parseDurationMinutes("48")).toBe(2880);
    expect(parseDurationMinutes("1")).toBe(60);
    expect(parseDurationMinutes("2g")).toBe(2880);
    expect(parseDurationMinutes(" 3 gün ")).toBe(4320);
    expect(parseDurationMinutes("14g")).toBe(20160);
    expect(parseDurationMinutes("12 saat")).toBe(720);
    expect(parseDurationMinutes("")).toBeNull();
    expect(parseDurationMinutes(null)).toBeNull();
    for (const bad of ["0", "15g", "337", "1.5", "-2", "abc", "2h"]) {
      expect(parseDurationMinutes(bad), bad).toBeNaN();
    }
  });

  it("seçenekler: sıralı, tekil, en fazla 12; geçersiz biri → null", () => {
    expect(parseDurationChoices("48, 24, 2g, 24")).toEqual([1440, 2880]);
    expect(parseDurationChoices("")).toEqual([]);
    expect(parseDurationChoices("24, x")).toBeNull();
    expect(
      parseDurationChoices(Array.from({ length: 13 }, (_, i) => String(i + 1)).join(",")),
    ).toBeNull();
  });

  it("form değerine geri yazma ve okunur süre", () => {
    expect(durationInput(2880)).toBe("2g");
    expect(durationInput(2160)).toBe("36");
    expect(durationInput(null)).toBe("");
    for (const m of [60, 720, 1440, 2160, 4320, 20160]) {
      expect(parseDurationMinutes(durationInput(m))).toBe(m);
    }
    expect(formatMinutes(1440)).toBe("1 gün");
    expect(formatMinutes(90)).toBe("1 sa 30 dk");
    expect(formatMinutes(null)).toBe("—");
  });
});

describe("kalan süre ve diğer alanlar", () => {
  it("kalan süre", () => {
    expect(formatRemaining(null)).toBe("—");
    expect(formatRemaining(0)).toBe("süresi doldu");
    expect(formatRemaining(30)).toBe("1 dk");
    expect(formatRemaining(45 * 60)).toBe("45 dk");
    expect(formatRemaining(3 * 3600 + 120)).toBe("3 sa 2 dk");
    expect(formatRemaining(2 * 86400 + 3 * 3600)).toBe("2 gün 3 sa");
  });

  it("tarih, sayı, not, misafir adı, uuid", () => {
    expect(parseIsoDate("2027-02-28")).toBe("2027-02-28");
    expect(parseIsoDate("2027-02-30")).toBeNull();
    expect(parseIsoDate("28.02.2027")).toBeNull();
    expect(parseCount("2", 50)).toBe(2);
    expect(parseCount("", 50)).toBeNull();
    expect(parseCount("51", 50)).toBeNaN();
    expect(parseCount("1e2", 50)).toBeNaN();
    expect(parseNote("  ")).toBeNull();
    expect(parseNote("x".repeat(501))).toBeUndefined();
    expect(parseGuestName("  Ayşe   Yılmaz ")).toBe("Ayşe Yılmaz");
    expect(parseGuestName("x".repeat(121))).toBeUndefined();
    expect(isUuid("00000000-0000-4000-8000-000000000000")).toBe(true);
    expect(isUuid("x")).toBe(false);
  });
});

describe("panel sabitleri ve sınırlar", () => {
  it("kesinleştirme 3e'ye kadar kapalı; hata mesajları tanımlı", () => {
    expect(OPTION_CONVERT_ENABLED).toBe(false);
    expect(ADMIN_OPTION_ERRORS.convert_disabled).toMatch(/3e/);
  });

  it("panel kodu rezervasyon, worker, ayrıştırıcı, iCal ve API modüllerine YAZMAZ (yalnız opsiyon fonksiyonları)", () => {
    const files = [
      "src/server/admin/options.ts",
      "src/app/admin/(panel)/opsiyonlar/actions.ts",
      "src/app/admin/(panel)/opsiyonlar/page.tsx",
      "src/app/admin/(panel)/opsiyonlar/[id]/page.tsx",
      "src/app/admin/(panel)/opsiyonlar/islem/[id]/page.tsx",
      "src/app/admin/(panel)/opsiyonlar/ayarlar/page.tsx",
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      expect(
        imports.filter((i) => /server\/(reservations|whatsapp|ical|api)|wa-calendar/.test(i)),
        f,
      ).toEqual([]);
      const fns = [...src.matchAll(/public\.(app_[a-z_]+)\(/g)].map((m) => m[1]!);
      for (const fn of fns) expect(fn, f).toMatch(/^app_option_admin_/);
    }
  });
});
