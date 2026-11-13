/**
 * Acente API'si (1. aşama) — saf yardımcılar: anahtar üretimi ve özetleme, Authorization
 * başlığı, sorgu parametreleri ve hata yanıtları. Veritabanı davranışı:
 * tests/integration/api.test.ts.
 */
import { describe, expect, it } from "vitest";

import * as apiMeta from "@/lib/api-meta";
import { API_KEY_PATTERN } from "@/lib/api-meta";
import {
  errorResponse,
  parseAvailabilityQuery,
  parseListQuery,
  rateHeaders,
} from "@/server/api/http";
import * as apiKeys from "@/server/api/keys";
import { bearerKey, generateApiKey, hashApiKey } from "@/server/api/keys";

describe("API anahtarı", () => {
  it("biçim: kg_live_<8 önek>_<43 gizli>; özet 64 hex; açık anahtar özette yok", () => {
    const k = generateApiKey();
    expect(k.key).toMatch(API_KEY_PATTERN);
    expect(k.key.startsWith(`kg_live_${k.prefix}_`)).toBe(true);
    expect(k.prefix).toMatch(/^[a-z2-7]{8}$/);
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.hash).toBe(hashApiKey(k.key));
    expect(k.hash).not.toContain(k.key.slice(17));
  });

  it("her üretim farklıdır (rastgele)", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().key));
    const prefixes = new Set(Array.from({ length: 200 }, () => generateApiKey().prefix));
    expect(keys.size).toBe(200);
    expect(prefixes.size).toBeGreaterThan(195);
  });

  it("Authorization: yalnız 'Bearer <geçerli biçim>'", () => {
    const { key } = generateApiKey();
    expect(bearerKey(`Bearer ${key}`)).toBe(key);
    expect(bearerKey(`bearer ${key}`)).toBe(key);
    expect(bearerKey(key)).toBeNull();
    expect(bearerKey(`Basic ${key}`)).toBeNull();
    expect(bearerKey(`Bearer ${key}x`)).toBeNull();
    expect(bearerKey(`Bearer ${key.replace("kg_live_", "kg_test_")}`)).toBeNull();
    expect(bearerKey("Bearer ")).toBeNull();
    expect(bearerKey(null)).toBeNull();
    expect(bearerKey(`Bearer ${"a".repeat(300)}`)).toBeNull();
  });
});

describe("acente erişim kodu kaldırıldı (0062)", () => {
  it("kod üretme, biçimleme ve özetleme yardımcıları artık dışa açılmıyor", () => {
    for (const name of ["generateAccessCode", "hashAccessCode", "accessCodeHashFromInput"]) {
      expect(apiKeys).not.toHaveProperty(name);
    }
    for (const name of [
      "API_ACCESS_CODE_ALPHABET",
      "API_ACCESS_CODE_PATTERN",
      "normalizeAccessCode",
    ]) {
      expect(apiMeta).not.toHaveProperty(name);
    }
  });
});

const url = (q: string) => new URL(`https://app.example.test/api/v1/x${q}`);

describe("parametreler", () => {
  it("liste: limit 1-500 (varsayılan 100), cursor UUID; bilinmeyen parametre 400", () => {
    expect(parseListQuery(url(""))).toEqual({ ok: true, value: { limit: 100, after: null } });
    expect(parseListQuery(url("?limit=500"))).toMatchObject({ ok: true, value: { limit: 500 } });
    for (const q of ["?limit=0", "?limit=501", "?limit=abc", "?limit=-1", "?cursor=1", "?x=1"]) {
      expect(parseListQuery(url(q)).ok).toBe(false);
    }
    const id = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    expect(parseListQuery(url(`?cursor=${id.toUpperCase()}`))).toMatchObject({
      ok: true,
      value: { after: id },
    });
  });

  it("müsaitlik: varsayılan bugün + 90 gün; [from, to)", () => {
    expect(parseAvailabilityQuery(url(""), "2026-11-12")).toEqual({
      ok: true,
      value: { from: "2026-11-12", to: "2027-02-10" },
    });
    expect(parseAvailabilityQuery(url("?from=2027-07-01&to=2027-08-01"), "2026-11-12")).toEqual({
      ok: true,
      value: { from: "2027-07-01", to: "2027-08-01" },
    });
  });

  it("müsaitlik: geçersiz tarih, ters/boş aralık, 366 günden uzun, 12 ay geri / 24 ay ileri sınırı", () => {
    const today = "2026-11-12";
    for (const q of [
      "?from=2027-02-30",
      "?from=12.07.2027",
      "?to=2027-13-01",
      "?from=2027-07-10&to=2027-07-10",
      "?from=2027-07-10&to=2027-07-01",
      "?from=2027-01-01&to=2028-01-03",
      "?from=2025-11-10&to=2025-12-01",
      "?from=2028-11-01&to=2028-11-20",
      "?property=1",
    ]) {
      expect(parseAvailabilityQuery(url(q), today).ok, q).toBe(false);
    }
    expect(parseAvailabilityQuery(url("?from=2025-11-11&to=2025-12-01"), today).ok).toBe(true);
    expect(parseAvailabilityQuery(url("?from=2028-10-01&to=2028-11-12"), today).ok).toBe(true);
  });
});

describe("yanıtlar", () => {
  it("hata gövdesi sabit: yalnız code + message; doğru HTTP kodu", async () => {
    const cases = [
      ["unauthorized", 401],
      ["account_disabled", 403],
      ["not_found", 404],
      ["invalid_request", 400],
      ["rate_limited", 429],
      ["method_not_allowed", 405],
      ["internal_error", 500],
    ] as const;
    for (const [code, status] of cases) {
      const r = errorResponse(code);
      expect(r.status).toBe(status);
      expect(r.headers.get("cache-control")).toBe("no-store");
      const body = (await r.json()) as { error: Record<string, unknown> };
      expect(Object.keys(body)).toEqual(["error"]);
      expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
      expect(body.error.code).toBe(code);
    }
    expect(errorResponse("unauthorized").headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("sınır başlıkları", () => {
    const now = new Date("2026-11-12T10:00:20Z");
    expect(
      rateHeaders({ limit: 120, remaining: 7, resetAt: new Date("2026-11-12T10:01:00Z") }, now),
    ).toEqual({
      "x-ratelimit-limit": "120",
      "x-ratelimit-remaining": "7",
      "x-ratelimit-reset": "40",
    });
  });
});
