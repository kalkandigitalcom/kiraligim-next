/**
 * Yerel test arayüzü: varsayılan 127.0.0.1'e bağlanır; konteynerde WA_HTTP_HOST=0.0.0.0 ile
 * çalışır ve dışarıya yalnız sunucunun 127.0.0.1:4010 port eşlemesiyle (SSH tüneli) açılır. Bağlantı durumu, QR (yalnız gerektiğinde,
 * önbelleğe alınmadan), görülen gruplar ve son olaylar. Dış kaynak yok; CSP ile kilitli.
 * DNS rebinding'e karşı Host başlığı denetlenir; durum değiştiren istek tek kullanımlık
 * süreç token'ı ve aynı köken ister.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import QRCode from "qrcode";

import { istanbulTime, maskNumber } from "./extract.ts";
import type { WaGateway } from "./session.ts";

const STATUS_LABEL: Record<string, string> = {
  starting: "Başlatılıyor",
  lease_wait: "Tek kopya kilidi bekleniyor",
  qr: "QR bekleniyor",
  connecting: "Bağlanıyor",
  open: "Bağlı",
  backoff: "Yeniden bağlanacak",
  needs_qr: "Yeniden QR gerekli",
  blocked: "Hesap erişimi reddedildi",
  replaced: "Başka kopya bağlı",
  stopped: "Durdu",
};

export function statusJson(gw: WaGateway, testGroupJid: string | null) {
  return {
    status: gw.status,
    statusLabel: STATUS_LABEL[gw.status] ?? gw.status,
    reason: gw.reason,
    hasQr: gw.status === "qr" && Boolean(gw.qr),
    mode: gw.mode,
    stats: gw.stats,
    lastCode: gw.lastCode,
    degraded: gw.degraded,
    pendingMessages: gw.pendingCount,
    protocolVersion: gw.protocolVersion,
    watchdogMinutes: Math.round(gw.watchdogWindowMs / 60_000),
    // Aşama 1.1: mesaj alımı teşhisi (sayaçlar ve zamanlar; metin/numara yok).
    diagnostics: gw.diag?.snapshot() ?? null,
    account: maskNumber(gw.account),
    connectedAt: gw.connectedAt ? istanbulTime(gw.connectedAt) : null,
    testGroupJid,
    groups: [...gw.groups.values()].map((g) => ({
      jid: g.jid,
      subject: g.subject,
      count: g.count,
      lastAt: istanbulTime(g.lastAt),
      isTest: g.jid === testGroupJid,
      dbStatus: g.dbStatus ?? null,
    })),
    events: gw.events.map((e) => ({ ...e, at: istanbulTime(e.at) })),
  };
}

function page(token: string, nonce: string) {
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kiraligim WhatsApp Test</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--bg:#f6f8f9;--card:#fff;--ink:#0f2a33;--muted:#5b6b70;--line:#dfe6e8;--ok:#0b6f74;--warn:#b45309;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0e1416;--card:#162024;--ink:#e6eef0;--muted:#94a6ab;--line:#26343a;--ok:#4fc3c8;--warn:#f0a050;--err:#ff7a6e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:24px 16px;display:grid;gap:16px}
h1{font-size:20px;margin:0}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.muted{color:var(--muted)}.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:600;border:1px solid currentColor}
.open{color:var(--ok)}.qr,.connecting,.backoff,.starting,.lease_wait{color:var(--warn)}.stopped,.needs_qr,.blocked,.replaced{color:var(--err)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:12px 0 0}dt{color:var(--muted)}dd{margin:0;word-break:break-all}
#qr img{width:264px;height:264px;background:#fff;padding:8px;border-radius:8px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line);vertical-align:top}
code{font-size:13px;word-break:break-all}ul{list-style:none;padding:0;margin:0;display:grid;gap:6px;font-size:14px}
.error{color:var(--err)}.reaction{color:var(--ok)}button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
</style></head><body><main>
<h1>Kiraligim WhatsApp · Faz 1 test bağlantısı</h1>
<p class="muted">Yalnız test numarası. Yalnız okuma ve test grubundaki mesaja tepki; mesaj gönderilmez, takvim veya fiyat değişmez.</p>
<section class="card"><span id="badge" class="badge">…</span> <span id="reason" class="muted"></span>
<dl><dt>Biçim</dt><dd id="mode">—</dd><dt>Bağlı hesap</dt><dd id="account">—</dd><dt>Bağlandı</dt><dd id="since">—</dd><dt>Test grubu</dt><dd id="group">—</dd><dt>Sayaçlar</dt><dd id="stats">—</dd></dl></section>
<section class="card" id="qrbox" hidden><strong>QR'ı test numarasının telefonundan okutun</strong>
<p class="muted">WhatsApp → Ayarlar → Bağlı cihazlar → Cihaz bağla. QR yaklaşık 20 sn'de bir yenilenir.</p><div id="qr"></div></section>
<section class="card"><strong>Görülen gruplar</strong><p class="muted" id="groupsHint">A1 biçiminde gruplar veritabanına kaydedilir; işletmeye eşleştirme panelden (Bekleyen gruplar) yapılır. Faz 1 test biçiminde test grubunun kimliğini <code>WA_TEST_GROUP_JID</code> olarak .env'e yazın.</p>
<table><thead><tr><th>Grup</th><th>Kimlik</th><th>Kayıtlı mesaj</th><th>Son</th></tr></thead><tbody id="groups"><tr><td colspan="4" class="muted">Henüz mesaj yok.</td></tr></tbody></table></section>
<section class="card"><strong>Son olaylar</strong><ul id="events"></ul></section>
<section class="card"><button id="reset" type="button">Oturumu sıfırla (bağlantıyı kaldır, yeni QR)</button></section>
</main>
<script nonce="${nonce}">
const token=${JSON.stringify(token)};let qrShown=0;
const $=id=>document.getElementById(id);
const t=(el,s)=>{el.textContent=s};
async function refresh(){
  let s;try{s=await (await fetch('/status.json',{cache:'no-store'})).json()}catch{t($('reason'),'Sunucuya ulaşılamıyor.');return}
  const b=$('badge');b.className='badge '+s.status;t(b,s.statusLabel);t($('reason'),s.reason||'');
  t($('mode'),s.mode==='a1'?'A1: grup kaydı ve mesaj kuyruğu (veritabanı)':'Faz 1 test biçimi (veritabanı yok)');
  t($('stats'),s.mode==='a1'?'kaydedilen '+s.stats.stored+' · yinelenen '+s.stats.duplicate+' · bağlı olmayan grup '+s.stats.ignored+' · doğrulanan numara '+s.stats.verified+' · reddedilen kod '+s.stats.rejectedCodes+' · hata '+s.stats.errors:'—');
  t($('account'),s.account);t($('since'),s.connectedAt||'—');t($('group'),s.testGroupJid||'tanımlı değil (tepki yok)');
  $('qrbox').hidden=!s.hasQr;
  if(s.hasQr&&Date.now()-qrShown>4000){qrShown=Date.now();const img=new Image();img.alt='Bağlantı QR kodu';img.src='/qr.svg?'+qrShown;$('qr').replaceChildren(img)}
  if(!s.hasQr){$('qr').replaceChildren()}
  const g=$('groups');if(s.groups.length){g.replaceChildren(...s.groups.map(x=>{const tr=document.createElement('tr');
    for(const v of [(x.subject||'(adsız)')+(x.isTest?' · test':'')+(x.dbStatus?' · '+({discovered:'bağlı değil',linked:'bağlı',suspended:'askıda',left:'ayrıldı'}[x.dbStatus]||x.dbStatus):''),x.jid,String(x.count),x.lastAt]){const td=document.createElement('td');if(v===x.jid){const c=document.createElement('code');t(c,v);td.append(c)}else t(td,v);tr.append(td)}return tr}))}
  $('events').replaceChildren(...s.events.map(e=>{const li=document.createElement('li');li.className=e.kind;t(li,e.at+' · '+e.text);return li}));
}
$('reset').addEventListener('click',async()=>{if(!confirm('Bu bilgisayarın bağlantısı kaldırılacak ve yerel oturum anahtarları silinecek. Devam?'))return;
  await fetch('/reset',{method:'POST',headers:{'x-test-token':token}});refresh()});
refresh();setInterval(refresh,2000);
</script></body></html>`;
}

export function startServer(
  gw: WaGateway,
  port: number,
  testGroupJid: string | null,
  host = "127.0.0.1",
) {
  const token = randomBytes(24).toString("base64url");
  let allowedHosts = new Set<string>();
  const server = http.createServer(async (req, res) => {
    const nonce = randomBytes(16).toString("base64");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    if (!allowedHosts.has(req.headers.host ?? "")) {
      res.writeHead(421).end("Yalnız localhost.");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.setHeader(
          "content-security-policy",
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
        );
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(token, nonce));
        return;
      }
      // Sağlık kontrolü (Docker HEALTHCHECK): GERÇEK WhatsApp bağlantı durumu. Numara, grup, QR yok.
      // 200: bağlı; ilk eşleştirme (QR) bekleniyor; ya da kısa süredir (healthGrace) yeniden bağlanıyor.
      // 503: uzun süredir bağlanamıyor, yeniden QR gerekli, erişim reddedildi, başka kopya bağlı,
      // tek kopya kilidi başkasında veya durdu. Yeniden başlatmayı watchdog yapar (süreç çıkışı);
      // Docker "unhealthy" konteyneri kendiliğinden yeniden başlatmaz.
      if (req.method === "GET" && url.pathname === "/healthz") {
        const h = gw.health();
        res
          .writeHead(h.ok ? 200 : 503, { "content-type": "application/json; charset=utf-8" })
          .end(JSON.stringify({ ...h, mode: gw.mode }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/status.json") {
        res
          .writeHead(200, { "content-type": "application/json; charset=utf-8" })
          .end(JSON.stringify(statusJson(gw, testGroupJid)));
        return;
      }
      if (req.method === "GET" && url.pathname === "/qr.svg") {
        if (gw.status !== "qr" || !gw.qr) {
          res.writeHead(404).end();
          return;
        }
        const svg = await QRCode.toString(gw.qr, {
          type: "svg",
          margin: 1,
          errorCorrectionLevel: "M",
        });
        res.writeHead(200, { "content-type": "image/svg+xml" }).end(svg);
        return;
      }
      if (req.method === "POST" && url.pathname === "/reset") {
        const origin = req.headers.origin;
        const sameOrigin = !origin || allowedHosts.has(origin.replace(/^http:\/\//, ""));
        if (req.headers["x-test-token"] !== token || !sameOrigin) {
          res.writeHead(403).end("Reddedildi.");
          return;
        }
        res.writeHead(202).end("Sıfırlanıyor.");
        void gw.reset();
        return;
      }
      res.writeHead(404).end();
    } catch {
      res.writeHead(500).end("Hata.");
    }
  });
  server.listen(port, host, () => {
    const actual = (server.address() as AddressInfo).port;
    allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
    console.log(`[wa] Test arayüzü: http://localhost:${actual} (yalnız bu bilgisayardan).`);
  });
  return server;
}
