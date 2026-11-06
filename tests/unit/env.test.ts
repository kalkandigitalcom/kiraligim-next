import { describe, expect, it } from "vitest";

import { checkDatabaseName, EnvError, parseEnv } from "@/lib/env";

const base = {
  NODE_ENV: "development",
  APP_ENV: "local",
  APP_NAME: "Kiralığım",
  APP_URL: "http://app.localhost:3000",
  ADMIN_URL: "http://admin.localhost:3000",
  PUBLIC_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://app_user:x@localhost:5433/lodging_dev",
};

describe("parseEnv", () => {
  it("geçerli yerel ortamı kabul eder", () => {
    const env = parseEnv(base);
    expect(env.APP_NAME).toBe("Kiralığım");
    expect(env.APP_ENV).toBe("local");
  });

  it("eksik değişkende açık hata verir ve değerleri sızdırmaz", () => {
    const { APP_NAME: _omit, ...rest } = base;
    expect(() => parseEnv(rest)).toThrow(EnvError);
    try {
      parseEnv({ ...rest, DATABASE_URL: "postgres://app_user:COKGIZLI@localhost/lodging_prod" });
    } catch (err) {
      expect(String(err)).toContain("APP_NAME");
      expect(String(err)).not.toContain("COKGIZLI");
    }
  });

  it("production'da dev veritabanını reddeder (emniyet kemeri)", () => {
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: "production",
        APP_ENV: "production",
        APP_URL: "https://app.example.com",
        ADMIN_URL: "https://admin.example.com",
        PUBLIC_URL: "https://example.com",
      }),
    ).toThrow(/_prod/);
  });

  it("geliştirmede production veritabanını reddeder", () => {
    expect(() =>
      parseEnv({ ...base, DATABASE_URL: "postgres://app_user:x@db/lodging_prod" }),
    ).toThrow(/_dev/);
  });

  it("production'da https zorunlu", () => {
    expect(() =>
      parseEnv({
        ...base,
        APP_ENV: "production",
        DATABASE_URL: "postgres://u:p@db/lodging_prod",
      }),
    ).toThrow(/https/);
  });

  it("panel host'ları aynı olamaz", () => {
    expect(() => parseEnv({ ...base, ADMIN_URL: base.APP_URL })).toThrow(/farklı host/);
  });
});

describe("checkDatabaseName", () => {
  it.each([
    ["production", "postgres://u:p@h/lodging_prod", null],
    ["development", "postgres://u:p@h/lodging_dev", null],
    ["test", "postgres://u:p@h/x_test", null],
  ] as const)("%s → %s", (appEnv, url, expected) => {
    expect(checkDatabaseName(appEnv, url)).toBe(expected);
  });

  it("veritabanı adı yoksa hata döner", () => {
    expect(checkDatabaseName("development", "postgres://u:p@h")).toMatch(/_dev/);
  });
});
