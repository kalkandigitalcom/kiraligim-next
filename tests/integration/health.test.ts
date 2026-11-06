import { afterEach, describe, expect, inject, it, vi } from "vitest";

import { resetEnvCache } from "@/lib/env";

const db = inject("testDb");

const baseEnv = {
  APP_ENV: "test",
  APP_NAME: "Test",
  APP_URL: "http://app.localhost:3000",
  ADMIN_URL: "http://admin.localhost:3000",
  PUBLIC_URL: "http://localhost:3000",
  LOG_LEVEL: "error",
};

async function resetDb() {
  const g = globalThis as { __kiraligimPool?: { end(): Promise<void> }; __kiraligimDb?: unknown };
  await g.__kiraligimPool?.end().catch(() => undefined);
  delete g.__kiraligimPool;
  delete g.__kiraligimDb;
  resetEnvCache();
}

describe("GET /api/health", () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  afterEach(async () => {
    vi.unstubAllEnvs();
    await resetDb();
  });

  it("veritabanına erişince 200 döner", async () => {
    for (const [k, v] of Object.entries({ ...baseEnv, DATABASE_URL: db.appUrl })) vi.stubEnv(k, v);
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", env: "test", checks: { database: "ok" } });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("veritabanına erişemezse 503 döner ve ayrıntı sızdırmaz", async () => {
    const bad = new URL(db.appUrl);
    bad.password = "yanlis-parola";
    for (const [k, v] of Object.entries({ ...baseEnv, DATABASE_URL: bad.toString() }))
      vi.stubEnv(k, v);
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toMatch(/password|yanlis|authentication/i);
    expect(JSON.parse(text)).toMatchObject({ status: "degraded", checks: { database: "error" } });
  });
});
