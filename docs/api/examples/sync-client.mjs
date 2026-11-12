// Kiraligim takvim senkron istemcisi — örnek (Node.js 20+, bağımlılıksız).
//
//   KG_API_KEY=kg_live_… node sync-client.mjs
//
// Akış: izinli villaları bağla → hesap cursor'ı al → her bağlantı için snapshot → hesap akışını
// düzenli sorgula. Durum (cursor ve yerel takvim) burada bellekte; gerçek sistemde kalıcı saklayın.
const BASE = process.env.KG_API_BASE ?? "https://app.kiraligim.com";
const KEY = process.env.KG_API_KEY;
if (!KEY) throw new Error("KG_API_KEY gerekli");

async function api(method, path, body) {
  for (;;) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        authorization: `Bearer ${KEY}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      await sleep(Number(res.headers.get("retry-after") ?? 60) * 1000);
      continue;
    }
    const json = await res.json();
    return { status: res.status, body: json };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const addDay = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Yerel takvim: bağlantı → dolu günler kümesi. Gerçekte kendi rezervasyon/blok tablonuz. */
const calendars = new Map();
function replaceAll(connectionId, busy) {
  const set = new Set();
  for (const b of busy) for (let x = b.start_date; x < b.end_date; x = addDay(x)) set.add(x);
  calendars.set(connectionId, set);
}
function applyChange(connectionId, c) {
  const set = calendars.get(connectionId);
  if (!set) return; // snapshot alınmamış bağlantı (hesap akışı zaten göndermez)
  for (let x = c.start_date; x < c.end_date; x = addDay(x)) set.delete(x);
  for (const b of c.busy_dates)
    for (let x = b.start_date; x < b.end_date; x = addDay(x)) set.add(x);
}

async function snapshot(connectionId) {
  const r = await api("GET", `/api/v1/calendar-connections/${connectionId}/snapshot`);
  if (r.status !== 200) return false; // 404: duraklatılmış veya bitmiş
  replaceAll(connectionId, r.body.busy_dates);
  return true;
}

async function main() {
  // 1. İzinli villaları bağla (external_property_id = sizin kimliğiniz).
  const props = (await api("GET", "/api/v1/properties?limit=500")).body.data;
  const connections = [];
  for (const p of props) {
    const r = await api("POST", "/api/v1/calendar-connections", {
      property_id: p.id,
      external_property_id: `KG-${p.id.slice(0, 8)}`,
    });
    if (r.status === 200 || r.status === 201) connections.push(r.body);
    else console.warn("bağlanamadı", p.id, r.body.error?.code);
  }

  // 2. Hesap cursor'ı SNAPSHOT'LARDAN ÖNCE alınır (arada değişiklik kaçmaz).
  let cursor = (await api("GET", "/api/v1/calendar-changes")).body.next_cursor;

  // 3. Her bağlantı için tam takvim.
  for (const c of connections) await snapshot(c.id);

  // 4. Düzenli sorgu (webhook kullanıyorsanız webhook geldiğinde de çağırın).
  for (;;) {
    const r = await api(
      "GET",
      `/api/v1/calendar-changes?cursor=${encodeURIComponent(cursor)}&limit=500`,
    );
    if (r.status === 410) {
      // Cursor süresi doldu: yeni cursor + tüm bağlantılar için yeniden snapshot.
      cursor = (await api("GET", "/api/v1/calendar-changes")).body.next_cursor;
      for (const c of connections) await snapshot(c.id);
      continue;
    }
    if (r.status !== 200) throw new Error(`akış hatası: ${r.body.error?.code}`);
    for (const ch of r.body.changes) applyChange(ch.connection_id, ch);
    cursor = r.body.next_cursor; // kalıcı saklayın
    if (!r.body.has_more) await sleep(60_000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
