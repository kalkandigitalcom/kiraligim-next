import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  sendWebhook,
  signWebhook,
  validateWebhookUrl,
  verifyWebhookSignature,
} from "@/server/api/webhooks";

/**
 * Webhook gönderici güvenliği (SSRF, DNS rebinding, yönlendirme, zaman aşımı) ve imza.
 * Yerel HTTPS sunucusu kendinden imzalı sertifikayla "hooks.kg-test.example" adına çalışır;
 * gönderici bu ada yalnız sahte çözümleyiciyle ulaşır (yerel adres yalnız testte izinli).
 */
const HOST = "hooks.kg-test.example";
let dir: string;
let ca: Buffer;
let server: https.Server;
let port = 0;
type Hit = { path: string; headers: http.IncomingHttpHeaders; body: string };
const hits: Hit[] = [];
let mode: "ok" | "redirect" | "slow" | "500" | "big" = "ok";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kg-wh-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${HOST}`,
      "-addext",
      `subjectAltName=DNS:${HOST}`,
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  ca = readFileSync(join(dir, "cert.pem"));
  server = https.createServer({ key: readFileSync(join(dir, "key.pem")), cert: ca }, (req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      hits.push({ path: req.url ?? "", headers: req.headers, body });
      if (mode === "redirect") {
        res.writeHead(302, { location: `https://${HOST}:${port}/followed` }).end();
      } else if (mode === "slow") {
        setTimeout(() => res.writeHead(200).end(), 2_000);
      } else if (mode === "500") {
        res.writeHead(500).end("secret internal details");
      } else if (mode === "big") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(5_000_000));
      } else {
        res.writeHead(204).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const local = (n = { calls: 0 }) => ({
  resolver: async () => {
    n.calls += 1;
    return [{ address: "127.0.0.1", family: 4 as const }];
  },
  allowAddress: (a: string) => a === "127.0.0.1",
  ca,
});
const url = (path = "/hook") => `https://${HOST}:${port}${path}`;

describe("validateWebhookUrl (kayıt)", () => {
  it.each([
    "http://hooks.example.com/x",
    "https://user:pw@hooks.example.com/x",
    "https://hooks.example.com:8443/x",
    "https://hooks.example.com/x#frag",
    "https://localhost/x",
    "https://foo.localhost/x",
    "https://printer.local/x",
    "https://svc.internal/x",
    "https://127.0.0.1/x",
    "https://10.0.0.5/x",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x",
    "https://[fd00::1]/x",
    "https://[::ffff:127.0.0.1]/x",
    "https://0x7f000001/x",
    "https://2130706433/x",
    "https://intranet/x",
    "ftp://hooks.example.com/x",
    "https://hooks.example.com/a b",
    `https://hooks.example.com/${"a".repeat(2050)}`,
    "",
    42,
  ])("reddeder: %s", (u) => {
    expect(validateWebhookUrl(u).ok).toBe(false);
  });

  it("geçerli https adresini normalleştirerek kabul eder", () => {
    expect(validateWebhookUrl("https://Hooks.Example.com/kg?x=1")).toEqual({
      ok: true,
      url: "https://hooks.example.com/kg?x=1",
    });
    expect(validateWebhookUrl("https://hooks.example.com:443")).toEqual({
      ok: true,
      url: "https://hooks.example.com/",
    });
    expect(validateWebhookUrl("https://8.8.8.8/hook").ok).toBe(true);
  });
});

describe("imza", () => {
  it("v1 = HMAC-SHA256(sır, ts.gövde); doğrulama zaman toleranslı ve sabit süreli", () => {
    const body = '{"id":"x"}';
    const sig = signWebhook("whsec_abc", 1_700_000_000, body);
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    const ok = (s: string | null, ts: string | null, b = body, now = 1_700_000_100) =>
      verifyWebhookSignature("whsec_abc", s, ts, b, { nowSeconds: now });
    expect(ok(sig, "1700000000")).toBe(true);
    expect(ok(sig, "1700000001")).toBe(false); // zaman damgası imzaya dahil
    expect(ok(sig, "1700000000", '{"id":"y"}')).toBe(false); // gövde değişti
    expect(ok(sig, "1700000000", body, 1_700_000_400)).toBe(false); // 5 dk'dan eski
    expect(
      verifyWebhookSignature("whsec_other", sig, "1700000000", body, { nowSeconds: 1_700_000_000 }),
    ).toBe(false);
    expect(ok(null, "1700000000")).toBe(false);
    expect(ok(sig, "abc")).toBe(false);
  });
});

describe("sendWebhook — SSRF ve ağ davranışı", () => {
  it("başarılı gönderim: sabitlenmiş adres, SNI/sertifika asıl ad için doğrulanır", async () => {
    mode = "ok";
    hits.length = 0;
    const n = { calls: 0 };
    const r = await sendWebhook(url(), { "kiraligim-event-id": "e1" }, '{"a":1}', local(n));
    expect(r).toEqual({ ok: true, status: 204 });
    expect(n.calls).toBe(1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.headers["kiraligim-event-id"]).toBe("e1");
    expect(hits[0]!.headers["content-type"]).toBe("application/json");
    expect(hits[0]!.body).toBe('{"a":1}');
  });

  it("sertifika adı tutmazsa (başka ada sabitleme) bağlantı kurulmaz", async () => {
    const r = await sendWebhook(`https://other.kg-test.example:${port}/x`, {}, "{}", local());
    expect(r).toEqual({ ok: false, code: "network" });
  });

  it("çözümlenen adreslerden BİRİ bile özel ağdaysa gönderilmez", async () => {
    hits.length = 0;
    for (const list of [
      [{ address: "127.0.0.1", family: 4 as const }],
      [{ address: "10.1.2.3", family: 4 as const }],
      [{ address: "169.254.169.254", family: 4 as const }],
      [
        { address: "8.8.8.8", family: 4 as const },
        { address: "192.168.1.1", family: 4 as const },
      ],
      [{ address: "::1", family: 6 as const }],
      [{ address: "::ffff:7f00:1", family: 6 as const }],
      [{ address: "fd12::1", family: 6 as const }],
    ]) {
      const r = await sendWebhook(url(), {}, "{}", { resolver: async () => list, ca });
      expect(r).toEqual({ ok: false, code: "blocked_address" });
    }
    expect(hits).toHaveLength(0);
  });

  it("DNS rebinding: ad bir kez çözülür, bağlantı doğrulanan adrese sabitlenir", async () => {
    mode = "ok";
    hits.length = 0;
    // İlk yanıt izinli adres; sonraki sorgular özel adres döndürür. Gönderici ikinci kez SORMAZ.
    let calls = 0;
    const r = await sendWebhook(url(), {}, "{}", {
      resolver: async () => {
        calls += 1;
        return calls === 1
          ? [{ address: "127.0.0.1", family: 4 }]
          : [{ address: "10.0.0.1", family: 4 }];
      },
      allowAddress: (a) => a === "127.0.0.1",
      ca,
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
    expect(hits).toHaveLength(1);
    // Rebinding'in ilk yanıtı özel adres olursa hiç bağlanılmaz.
    const r2 = await sendWebhook(url(), {}, "{}", {
      resolver: async () => [{ address: "10.0.0.1", family: 4 }],
      allowAddress: (a) => a === "127.0.0.1",
      ca,
    });
    expect(r2).toEqual({ ok: false, code: "blocked_address" });
    expect(hits).toHaveLength(1);
  });

  it("varsayılan politika: IP değişmezi/yerel ad DNS'e gitmeden reddedilir; http reddedilir", async () => {
    let calls = 0;
    const resolver = async () => {
      calls += 1;
      return [{ address: "8.8.8.8", family: 4 as const }];
    };
    for (const u of [
      `https://127.0.0.1:${port}/x`,
      "https://[::1]/x",
      "https://169.254.169.254/x",
      "https://localhost/x",
      "https://db.internal/x",
    ]) {
      expect(await sendWebhook(u, {}, "{}", { resolver })).toEqual({
        ok: false,
        code: "blocked_address",
      });
    }
    expect(calls).toBe(0);
    expect(await sendWebhook("http://hooks.example.com/x", {}, "{}", { resolver })).toEqual({
      ok: false,
      code: "invalid_url",
    });
    expect(await sendWebhook("https://u:p@hooks.example.com/x", {}, "{}", { resolver })).toEqual({
      ok: false,
      code: "invalid_url",
    });
  });

  it("DNS hatası → dns", async () => {
    const r = await sendWebhook(url(), {}, "{}", {
      resolver: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(r).toEqual({ ok: false, code: "dns" });
    expect(await sendWebhook(url(), {}, "{}", { resolver: async () => [] })).toEqual({
      ok: false,
      code: "dns",
    });
  });

  it("yönlendirme izlenmez (3xx = başarısız, hedefe istek gitmez)", async () => {
    mode = "redirect";
    hits.length = 0;
    const r = await sendWebhook(url(), {}, "{}", local());
    expect(r).toEqual({ ok: false, code: "redirect", status: 302 });
    expect(hits.map((h) => h.path)).toEqual(["/hook"]);
  });

  it("zaman aşımı: yavaş sunucu süre sınırını aşamaz", async () => {
    mode = "slow";
    const t = Date.now();
    const r = await sendWebhook(url(), {}, "{}", { ...local(), timeoutMs: 300 });
    expect(r).toEqual({ ok: false, code: "timeout" });
    expect(Date.now() - t).toBeLessThan(1_500);
  });

  it("2xx dışı yanıt: yalnız durum kodu; gövde okunmaz/döndürülmez", async () => {
    mode = "500";
    const r = await sendWebhook(url(), {}, "{}", local());
    expect(r).toEqual({ ok: false, code: "http_status", status: 500 });
    expect(JSON.stringify(r)).not.toContain("secret");
    mode = "big";
    expect(await sendWebhook(url(), {}, "{}", local())).toEqual({ ok: true, status: 200 });
    mode = "ok";
  });

  it("bağlantı reddi → network", async () => {
    const r = await sendWebhook(`https://${HOST}:1/x`, {}, "{}", local());
    expect(r).toEqual({ ok: false, code: "network" });
  });
});
