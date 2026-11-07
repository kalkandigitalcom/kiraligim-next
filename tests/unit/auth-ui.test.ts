import { describe, expect, it, vi } from "vitest";

import { authErrorMessage, GENERIC_AUTH_ERROR } from "@/lib/auth-messages";
import { slugify } from "@/lib/slug";
import { WORKSPACE_SLUG_PATTERN } from "@/db/schema/tenancy";
import { createAuthRouteHandler } from "@/server/auth/route-handler";

describe("/api/auth route: host ve kullanılabilirlik denetimi", () => {
  const make = (available = true) => {
    const handle = vi.fn(async () => new Response("ok"));
    const route = createAuthRouteHandler({
      appUrl: "https://app.kiraligim.com",
      isAvailable: () => available,
      handle,
    });
    return { route, handle };
  };
  const req = (host: string | null) =>
    new Request("http://localhost:3000/api/auth/get-session", {
      headers: host ? { host } : {},
    });

  it("yalnız app host'unu Better Auth'a iletir", async () => {
    const { route, handle } = make();
    const res = await route(req("app.kiraligim.com"));
    expect(await res.text()).toBe("ok");
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("host karşılaştırması büyük/küçük harf ve boşluk duyarsız", async () => {
    const { route, handle } = make();
    await route(req(" APP.Kiraligim.com "));
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it.each([["kiraligim.com"], ["admin.kiraligim.com"], ["evil.example"], [null]])(
    "%s host'unda 404 döner ve Better Auth çağrılmaz",
    async (host) => {
      const { route, handle } = make();
      const res = await route(req(host));
      expect(res.status).toBe(404);
      expect(handle).not.toHaveBeenCalled();
    },
  );

  it("kimlik ayarları eksikse 503 döner (sahte başarı yok)", async () => {
    const { route, handle } = make(false);
    const res = await route(req("app.kiraligim.com"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "AUTH_UNAVAILABLE" });
    expect(handle).not.toHaveBeenCalled();
  });
});

describe("slugify (işletme kısa adı önerisi)", () => {
  it.each([
    ["Kalkan Deniz Villaları", "kalkan-deniz-villalari"],
    ["ÇİĞDEM Şüheda Öz", "cigdem-suheda-oz"],
    ["  --Kaş & Kalkan!! 2026  ", "kas-kalkan-2026"],
    ["Château Âlâ", "chateau-ala"],
  ])("%s → %s", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("en fazla 48 karakter ve tire ile bitmez", () => {
    const s = slugify(`${"a".repeat(47)} b`);
    expect(s.length).toBeLessThanOrEqual(48);
    expect(s.endsWith("-")).toBe(false);
  });

  it("üretilen değer veritabanı kuralına uyar", () => {
    for (const name of ["Kalkan Deniz Villaları", "Ölüdeniz Evleri", "Villa 7"]) {
      expect(slugify(name)).toMatch(new RegExp(WORKSPACE_SLUG_PATTERN));
    }
  });
});

describe("authErrorMessage", () => {
  it("bilinen kodları Türkçeleştirir", () => {
    expect(authErrorMessage({ code: "INVALID_EMAIL_OR_PASSWORD", status: 401 })).toBe(
      "E-posta adresi veya şifre hatalı.",
    );
    expect(authErrorMessage({ code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" })).toMatch(/kapalı/);
  });

  it("429 deneme sınırı mesajı verir", () => {
    expect(authErrorMessage({ status: 429 })).toMatch(/Çok fazla deneme/);
  });

  it("bilinmeyen hatada ayrıntı sızdırmaz", () => {
    expect(authErrorMessage({ code: "SOMETHING_INTERNAL", status: 500 })).toBe(GENERIC_AUTH_ERROR);
    expect(authErrorMessage(null)).toBe(GENERIC_AUTH_ERROR);
  });
});
