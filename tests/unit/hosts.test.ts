import { describe, expect, it } from "vitest";

import { hostMapFromUrls, resolveSurface, wwwRedirectOrigin } from "@/lib/hosts";

const map = hostMapFromUrls({
  APP_URL: "https://app.kiraligim.com",
  ADMIN_URL: "https://admin.kiraligim.com",
  PUBLIC_URL: "https://kiraligim.com",
});

describe("resolveSurface", () => {
  it("alan adına göre yüzeyi seçer", () => {
    expect(resolveSurface("app.kiraligim.com", map)).toBe("host");
    expect(resolveSurface("admin.kiraligim.com", map)).toBe("admin");
    expect(resolveSurface("kiraligim.com", map)).toBe("site");
  });

  it("büyük/küçük harf duyarsızdır", () => {
    expect(resolveSurface("ADMIN.Kiraligim.com", map)).toBe("admin");
  });

  it("tanımsız host için null döner", () => {
    expect(resolveSurface("evil.com", map)).toBeNull();
    expect(resolveSurface("app.kiraligim.com.evil.com", map)).toBeNull();
    expect(resolveSurface(null, map)).toBeNull();
  });

  it("port dahil eşleşir (yerel geliştirme)", () => {
    const local = hostMapFromUrls({
      APP_URL: "http://app.localhost:3000",
      ADMIN_URL: "http://admin.localhost:3000",
      PUBLIC_URL: "http://localhost:3000",
    });
    expect(resolveSurface("app.localhost:3000", local)).toBe("host");
    expect(resolveSurface("localhost:3000", local)).toBe("site");
    expect(resolveSurface("localhost:4000", local)).toBeNull();
  });
});

describe("wwwRedirectOrigin", () => {
  it("www public alan adını kök alana yönlendirir", () => {
    expect(wwwRedirectOrigin("www.kiraligim.com", map, "https://kiraligim.com")).toBe(
      "https://kiraligim.com",
    );
    expect(wwwRedirectOrigin("WWW.Kiraligim.com", map, "https://kiraligim.com")).toBe(
      "https://kiraligim.com",
    );
  });

  it("panel alan adlarını ve yabancı host'ları yönlendirmez", () => {
    expect(wwwRedirectOrigin("app.kiraligim.com", map, "https://kiraligim.com")).toBeNull();
    expect(wwwRedirectOrigin("www.app.kiraligim.com", map, "https://kiraligim.com")).toBeNull();
    expect(wwwRedirectOrigin("www.evil.com", map, "https://kiraligim.com")).toBeNull();
    expect(wwwRedirectOrigin(null, map, "https://kiraligim.com")).toBeNull();
  });

  it("public alan adı zaten www ise yönlendirme yapmaz", () => {
    const wwwMap = hostMapFromUrls({
      APP_URL: "https://app.example.com",
      ADMIN_URL: "https://admin.example.com",
      PUBLIC_URL: "https://www.example.com",
    });
    expect(wwwRedirectOrigin("www.www.example.com", wwwMap, "https://www.example.com")).toBeNull();
  });
});
