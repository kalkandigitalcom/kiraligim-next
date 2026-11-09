import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { startServer, statusJson } from "../src/server.ts";
import type { WaGateway } from "../src/session.ts";

const QR = "2@gizli-qr-icerigi-asla-json'da-olmamali";

const fake = {
  status: "qr",
  reason: null,
  qr: QR,
  account: "905321112233",
  connectedAt: null,
  events: [{ at: "2026-11-09T10:00:00.000Z", kind: "info", text: "QR hazır" }],
  groups: new Map([
    [
      "120363025555555555@g.us",
      {
        jid: "120363025555555555@g.us",
        subject: "Test",
        lastAt: "2026-11-09T10:00:00.000Z",
        count: 1,
      },
    ],
  ]),
  resetCalls: 0,
  async reset(this: { resetCalls: number }) {
    this.resetCalls += 1;
  },
} as unknown as WaGateway & { resetCalls: number };

let server: http.Server;
let port: number;

const get = (path: string, host = `localhost:${port}`) =>
  new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      req.on("error", reject);
      req.end();
    },
  );

const post = (path: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { host: `localhost:${port}`, ...headers },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });

describe("yerel test arayüzü", () => {
  before(async () => {
    server = startServer(fake, 0, "120363025555555555@g.us");
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });
  after(() => server.close());

  it("durum JSON'unda QR ve tam numara yok", () => {
    const s = JSON.stringify(statusJson(fake, null));
    assert.ok(!s.includes(QR));
    assert.ok(!s.includes("905321112233"));
    assert.ok(s.includes('"hasQr":true'));
  });

  it("yalnız 127.0.0.1'e bağlı; başka Host başlığı reddedilir (DNS rebinding)", async () => {
    assert.equal((server.address() as AddressInfo).address, "127.0.0.1");
    assert.equal((await get("/status.json", "evil.example:80")).status, 421);
  });

  it("sayfa CSP ile kilitli ve önbelleğe alınmaz", async () => {
    const r = await get("/");
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-security-policy"]), /default-src 'none'/);
    assert.equal(r.headers["cache-control"], "no-store");
  });

  it("QR yalnız SVG olarak, önbelleksiz verilir", async () => {
    const r = await get("/qr.svg");
    assert.equal(r.status, 200);
    assert.match(r.body, /^<svg/);
    assert.equal(r.headers["cache-control"], "no-store");
  });

  it("sıfırlama token ve aynı köken ister", async () => {
    assert.equal(await post("/reset", {}), 403);
    assert.equal(await post("/reset", { "x-test-token": "yanlis" }), 403);
    const page = (await get("/")).body;
    const token = /const token="([^"]+)"/.exec(page)?.[1] ?? "";
    assert.equal(
      await post("/reset", { "x-test-token": token, origin: "http://evil.example" }),
      403,
    );
    assert.equal(fake.resetCalls, 0);
    assert.equal(
      await post("/reset", { "x-test-token": token, origin: `http://localhost:${port}` }),
      202,
    );
    assert.equal(fake.resetCalls, 1);
  });
});
