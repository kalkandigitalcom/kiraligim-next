import { randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import * as schema from "@/db/schema";
import { createMemoryTransport } from "@/lib/email/transports";
import { parseAuthEnv } from "@/server/auth/env";
import { createHostAuth } from "@/server/auth/host-auth";

/**
 * Better Auth'un gerçek akışları, gerçek tablolar ve YALNIZ app_user yetkileriyle.
 * Bir yetki eksik ya da fazla dar olsaydı bu akışlardan biri "permission denied" ile kırılırdı.
 * Not: Uç nokta uygulamada hâlâ bağlı değil; burada auth.handler doğrudan çağrılır.
 */
const db = inject("testDb");
const APP_URL = "http://app.localhost:3000";

describe("Better Auth akışları (app_user ile)", () => {
  const pool = new Pool({ connectionString: db.appUrl, max: 4 });
  const orm = drizzle(pool, { schema, casing: DB_CASING });
  const email = createMemoryTransport();
  const auth = createHostAuth({
    env: { APP_ENV: "test", APP_URL },
    authEnv: parseAuthEnv("test", {
      BETTER_AUTH_SECRET: "a".repeat(40),
      AUTH_SIGNUP_ENABLED: "true",
    }),
    db: orm,
    email,
    brandName: "Kiralığım",
    rateLimitEnabled: true,
  });
  afterAll(() => pool.end());

  const call = (
    pathname: string,
    opts: { body?: unknown; cookie?: string; ip: string; method?: string },
  ) =>
    auth.handler(
      new Request(`${APP_URL}/api/auth${pathname}`, {
        method: opts.method ?? (opts.body ? "POST" : "GET"),
        headers: {
          "content-type": "application/json",
          origin: APP_URL,
          "x-forwarded-for": opts.ip,
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
        },
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      }),
    );
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const urlIn = (text: string) => new URL(text.match(/https?:\/\/\S+/)![0]);

  const address = `ayse.${randomBytes(3).toString("hex")}@ornek.com`;
  const password = "Guclu-Parola-123";

  it("kayıt → doğrulama → giriş → oturum → şifre sıfırlama", async () => {
    let res = await call("/sign-up/email", {
      body: { email: address.toUpperCase(), password, name: "Ayşe" },
      ip: "203.0.113.1",
    });
    expect(res.status).toBe(200);

    const user = (await pool.query("select * from users where email = $1", [address])).rows[0];
    expect(user?.email).toBe(address);
    expect(user?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(user?.email_verified).toBe(false);
    const acc = (
      await pool.query("select provider_id, password from accounts where user_id = $1", [user.id])
    ).rows[0];
    expect(acc?.provider_id).toBe("credential");
    expect(acc?.password).not.toContain(password);

    await settle();
    const verifyMail = email.outbox.find(
      (m) => m.to === address && m.category === "auth.verify-email",
    );
    expect(verifyMail).toBeDefined();

    res = await call("/sign-in/email", { body: { email: address, password }, ip: "203.0.113.2" });
    expect(res.status).toBe(403);

    res = await auth.handler(
      new Request(urlIn(verifyMail!.text), { headers: { "x-forwarded-for": "203.0.113.3" } }),
    );
    expect([200, 302]).toContain(res.status);
    expect(
      (await pool.query("select email_verified from users where id = $1", [user.id])).rows[0]
        ?.email_verified,
    ).toBe(true);

    res = await call("/sign-in/email", { body: { email: address, password }, ip: "203.0.113.4" });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^kg\.session_token=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).not.toMatch(/Domain=/i);
    const cookie = setCookie.split(";")[0]!;

    res = await call("/get-session", { cookie, ip: "203.0.113.4" });
    expect(((await res.json()) as { user?: { email?: string } }).user?.email).toBe(address);
    const sess = (await pool.query("select ip_address from sessions where user_id = $1", [user.id]))
      .rows[0];
    expect(sess?.ip_address).toBe("203.0.113.4");

    res = await call("/request-password-reset", {
      body: { email: address, redirectTo: `${APP_URL}/sifre` },
      ip: "203.0.113.5",
    });
    expect(res.status).toBe(200);
    await settle();
    const resetMail = email.outbox.find(
      (m) => m.to === address && m.category === "auth.reset-password",
    );
    const token = urlIn(resetMail!.text).pathname.split("/").pop()!;
    const identifiers = (await pool.query("select identifier from verifications")).rows.map(
      (r) => r.identifier as string,
    );
    expect(identifiers.some((i) => i.includes(token))).toBe(false);

    res = await call("/reset-password", {
      body: { newPassword: "Yeni-Guclu-Parola-456", token },
      ip: "203.0.113.6",
    });
    expect(res.status).toBe(200);
    expect(
      (await pool.query("select count(*)::int as n from sessions where user_id = $1", [user.id]))
        .rows[0]?.n,
    ).toBe(0);

    res = await call("/sign-in/email", {
      body: { email: address, password: "Yeni-Guclu-Parola-456" },
      ip: "203.0.113.7",
    });
    expect(res.status).toBe(200);
    res = await call("/sign-out", {
      method: "POST",
      body: {},
      cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]!,
      ip: "203.0.113.7",
    });
    expect(res.status).toBe(200);
  });

  it("deneme sınırı rate_limits tablosunda tutulur ve aşımda 429 döner", async () => {
    const ip = "198.51.100.77";
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push(
        (
          await call("/sign-in/email", {
            body: { email: "x@y.com", password: "yanlis-parola" },
            ip,
          })
        ).status,
      );
    }
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes[3]).toBe(429);
    const row = (
      await pool.query("select count, last_request from rate_limits where key = $1", [
        `${ip}|/sign-in/email`,
      ])
    ).rows[0];
    expect(row?.count).toBe(3);
    expect(Number(row?.last_request)).toBeGreaterThan(Date.now() - 60_000);
  });
});
