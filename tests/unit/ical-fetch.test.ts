import http from "node:http";
import zlib from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createIcsFetcher } from "@/server/ical/fetch";

/**
 * İndiricinin HTTP yolu (yönlendirme, sıkıştırma, boyut, durum kodu, zaman aşımı) yerel bir test
 * sunucusuyla sınanır. Adresler yalnız 80/443 portuna izin verdiği için sunucu 127.0.0.1:80'de
 * açılır; bu port açılamıyorsa (ayrıcalık yok) testler atlanır. Yerel adres varsayılan politikada
 * YASAKTIR: yalnız bu testte "takvim.test" 127.0.0.1'e çözülür ve adres politikası gevşetilir.
 */
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
let lastHost = "";

const server = http.createServer((req, res) => {
  lastHost = req.headers.host ?? "";
  switch (req.url) {
    case "/ok.ics":
      res.writeHead(200, { "content-type": "text/calendar" });
      res.end(ICS);
      return;
    case "/gzip.ics":
      res.writeHead(200, { "content-type": "text/calendar", "content-encoding": "gzip" });
      res.end(zlib.gzipSync(ICS));
      return;
    case "/redirect":
      res.writeHead(302, { location: "/ok.ics" });
      res.end();
      return;
    case "/loop":
      res.writeHead(302, { location: "/loop" });
      res.end();
      return;
    case "/evil-redirect":
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      res.end();
      return;
    case "/big.ics":
      res.writeHead(200, { "content-type": "text/calendar" });
      res.end("X".repeat(3 * 1024 * 1024));
      return;
    case "/slow.ics":
      res.writeHead(200, { "content-type": "text/calendar" });
      res.write("BEGIN:VCALENDAR\r\n"); // yanıt hiç bitmez
      return;
    default:
      res.writeHead(404);
      res.end("yok");
  }
});

let listening = false;
beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.once("error", () => resolve());
    server.listen(80, "127.0.0.1", () => {
      listening = true;
      resolve();
    });
  });
});

afterAll(async () => {
  if (!listening) return;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const fetcher = createIcsFetcher({
  resolver: async () => [{ address: "127.0.0.1", family: 4 }],
  addressPolicy: (a) => a === "127.0.0.1",
  timeoutMs: 1500,
});
const url = (path: string) => `http://takvim.test${path}`;

describe("iCal indirme (HTTP yolu)", () => {
  const run = (name: string, fn: () => Promise<void>) =>
    it(name, async (ctx) => {
      if (!listening) ctx.skip();
      await fn();
    });

  run("başarılı indirme; bağlantı doğrulanan adrese, Host başlığı asıl ada", async () => {
    expect(await fetcher(url("/ok.ics"))).toEqual({ ok: true, text: ICS });
    expect(lastHost).toBe("takvim.test");
  });

  run("gzip açılır", async () => {
    expect(await fetcher(url("/gzip.ics"))).toEqual({ ok: true, text: ICS });
  });

  run("yönlendirme izlenir; döngü sınırlanır", async () => {
    expect(await fetcher(url("/redirect"))).toEqual({ ok: true, text: ICS });
    expect(await fetcher(url("/loop"))).toEqual({ ok: false, code: "http_status" });
  });

  run("özel adrese yönlendirme reddedilir", async () => {
    expect(await fetcher(url("/evil-redirect"))).toEqual({ ok: false, code: "blocked_address" });
  });

  run("2 MB üstü gövde, 404 ve zaman aşımı", async () => {
    expect(await fetcher(url("/big.ics"))).toEqual({ ok: false, code: "too_large" });
    expect(await fetcher(url("/yok.ics"))).toEqual({ ok: false, code: "http_status" });
    expect(await fetcher(url("/slow.ics"))).toEqual({ ok: false, code: "timeout" });
  });
});
