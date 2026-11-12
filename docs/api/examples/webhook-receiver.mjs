// Kiraligim webhook alıcısı — örnek (Node.js 20+, bağımlılıksız).
//
//   KG_WEBHOOK_SECRET=whsec_… PORT=8080 node webhook-receiver.mjs
//
// Üretimde bu sunucunun önünde HTTPS sonlandıran bir ters vekil (nginx, Caddy, yük dengeleyici)
// olmalıdır; Kiraligim yalnız https:// adreslerine gönderir.
//
// Kurallar: gövdeyi HAM okuyun, imzayı ve zaman damgasını doğrulayın, olay kimliğiyle tekrarları
// atlayın, işi kuyruğa alıp 10 saniye içinde 2xx dönün.
import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";

const SECRET = process.env.KG_WEBHOOK_SECRET;
if (!SECRET) throw new Error("KG_WEBHOOK_SECRET gerekli");
const TOLERANCE_SECONDS = 300;
const MAX_BODY = 64 * 1024;

export function verify(secret, headers, rawBody, now = Math.floor(Date.now() / 1000)) {
  const ts = headers["kiraligim-timestamp"];
  const sig = headers["kiraligim-signature"] ?? "";
  if (typeof ts !== "string" || !/^\d{1,12}$/.test(ts)) return false;
  if (Math.abs(now - Number(ts)) > TOLERANCE_SECONDS) return false;
  const expected = "v1=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Gerçek sistemde kalıcı depo (veritabanı tablosu, benzersiz anahtar) kullanın.
const seen = new Set();

/** Değişikliği yerel takvime uygula: [start_date, end_date) aralığını temizle, busy_dates'i yaz. */
async function applyChange(externalPropertyId, change) {
  // Örnek: await db.clearRange(externalPropertyId, change.start_date, change.end_date);
  //        for (const b of change.busy_dates) await db.markBusy(externalPropertyId, b.start_date, b.end_date);
  console.warn("uygula", externalPropertyId, change.change_id, change.start_date, change.end_date);
}

http
  .createServer((req, res) => {
    if (req.method !== "POST") return res.writeHead(405).end();
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!verify(SECRET, req.headers, raw)) return res.writeHead(401).end();
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return res.writeHead(400).end();
      }
      if (event.type !== "calendar.changed") return res.writeHead(204).end();
      if (seen.has(event.id)) return res.writeHead(204).end(); // tekrar teslim
      try {
        await applyChange(event.external_property_id, event.change);
        seen.add(event.id);
        res.writeHead(204).end();
      } catch {
        // 2xx dışı yanıt → Kiraligim aynı olayı (aynı kimlikle) yeniden dener; sıra korunur.
        res.writeHead(500).end();
      }
    });
  })
  .listen(Number(process.env.PORT ?? 8080));
