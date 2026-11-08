/**
 * Google Haritalar konumu: işletme sahibinin yapıştırdığı "Haritayı yerleştir" iframe kodundan
 * veya tam paylaşım bağlantısından YALNIZ güvenli gömme adresi çıkarılır. Saf ve bağımlılıksız:
 * sihirbaz (anında geri bildirim), Zod şeması, misafir sayfası (gösterimden önce yeniden
 * doğrulama) ve testler aynı fonksiyonu kullanır.
 *
 * Güvenlik:
 *  - Ham HTML hiçbir zaman saklanmaz veya sayfaya yazılmaz; iframe kodundan yalnız `src` okunur.
 *  - Sonuç iki kalıptan biridir ve her zaman sıfırdan üretilir (gelen adres aynen kullanılmaz):
 *      https://www.google.com/maps/embed?pb=<güvenli karakterler>
 *      https://www.google.com/maps?q=<enlem>,<boylam>&z=16&output=embed
 *  - Alan adı tam eşleşmeyle doğrulanır (google.com / google.com.tr ve www./maps. alt alanları);
 *    "google.com.evil.example", kullanıcı adı/parola içeren adres, http ve diğer şemalar reddedilir.
 *  - Kısa bağlantılar (maps.app.goo.gl, goo.gl/maps) çözülemez (sunucu dışarıya istek atmaz):
 *    anlaşılır hata döner.
 * Veritabanında aynı kalıplar CHECK kısıtıyla da zorlanır (MAP_EMBED_DB_PATTERN).
 */

export type MapParseError = "short_link" | "not_google" | "no_location" | "invalid";
export type MapParseResult = { ok: true; url: string } | { ok: false; error: MapParseError };

export const MAP_INPUT_MAX = 4000;
const PB_MAX = 1500;
const PB_RE = /^[A-Za-z0-9!._%:~*+-]+$/;

export const MAP_PARSE_MESSAGES: Record<MapParseError, string> = {
  short_link:
    "Kısa paylaşım bağlantıları desteklenmiyor. Google Haritalar'da Paylaş → Haritayı yerleştir'i seçip HTML kodunu kopyalayın veya tarayıcının adres çubuğundaki tam bağlantıyı yapıştırın.",
  not_google:
    "Yalnız Google Haritalar bağlantısı veya Google Haritalar yerleştirme kodu kabul edilir.",
  no_location:
    "Bu bağlantıda konum bilgisi bulunamadı. Google Haritalar'da Paylaş → Haritayı yerleştir'deki HTML kodunu yapıştırın.",
  invalid:
    "Harita bağlantısı anlaşılamadı. Google Haritalar'daki Haritayı yerleştir kodunu veya tam bağlantıyı yapıştırın.",
};

const GOOGLE_HOSTS = new Set([
  "google.com",
  "www.google.com",
  "maps.google.com",
  "google.com.tr",
  "www.google.com.tr",
  "maps.google.com.tr",
]);
const SHORT_HOSTS = new Set(["maps.app.goo.gl", "goo.gl", "g.co", "share.google"]);

/**
 * Veritabanı CHECK kalıbı (POSIX regex; JS'te de geçerli). PostgreSQL tekrar sayısını 255 ile
 * sınırladığı için pb uzunluğu burada değil, PB_MAX (kod) ve kolon uzunluğu kısıtıyla denetlenir.
 */
export const MAP_EMBED_DB_PATTERN =
  "^https://www\\.google\\.com/maps(/embed\\?pb=[A-Za-z0-9!._%:~*+-]+|\\?q=-?[0-9]{1,2}\\.[0-9]{1,6},-?[0-9]{1,3}\\.[0-9]{1,6}&z=16&output=embed)$";
const DB_RE = new RegExp(MAP_EMBED_DB_PATTERN);

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/gi, "&")
    .replace(/&#0*38;/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'");

/** "<iframe ... src="…" ...>" içinden src; iframe değilse girdi aynen. */
function extractSrc(input: string): string | null {
  if (!/<\s*iframe\b/i.test(input)) return input;
  const m = input.match(/<\s*iframe\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  const src = m?.[1] ?? m?.[2];
  return src ? decodeEntities(src).trim() : null;
}

const coord = (lat: number, lng: number): string | null => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return `https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}&z=16&output=embed`;
};

const NUM = "(-?\\d{1,3}(?:\\.\\d+)?)";
/** "36.26,29.41" veya "36.26, 29.41" */
function latLngText(v: string | null): string | null {
  if (!v) return null;
  const m = v.trim().match(new RegExp(`^${NUM}\\s*,\\s*${NUM}$`));
  return m ? coord(Number(m[1]), Number(m[2])) : null;
}

/** Paylaşım bağlantısından koordinat: önce iğne (!3d…!4d…), sonra @enlem,boylam, sonra q/query/ll. */
function fromShareUrl(u: URL): string | null {
  const full = decodeURIComponent(u.pathname + u.search);
  const pin = full.match(/!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/);
  if (pin) return coord(Number(pin[1]), Number(pin[2]));
  const at = u.pathname.match(/@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/);
  if (at) return coord(Number(at[1]), Number(at[2]));
  for (const k of ["q", "query", "ll", "center", "destination"]) {
    const r = latLngText(u.searchParams.get(k));
    if (r) return r;
  }
  return null;
}

/**
 * Yapıştırılan metni güvenli gömme adresine çevirir. Boş girdi geçerli değildir (çağıran boşu
 * "konum yok" olarak ayrıca ele alır).
 */
export function parseMapInput(raw: string): MapParseResult {
  const input = (raw ?? "").trim();
  if (!input || input.length > MAP_INPUT_MAX) return { ok: false, error: "invalid" };
  const src = extractSrc(input);
  if (!src) return { ok: false, error: "invalid" };
  let u: URL;
  try {
    u = new URL(/^\/\//.test(src) ? `https:${src}` : src);
  } catch {
    // Şemasız "maps.app.goo.gl/…" gibi yapıştırmalar.
    try {
      u = new URL(`https://${src}`);
    } catch {
      return { ok: false, error: "invalid" };
    }
    if (!u.hostname.includes(".")) return { ok: false, error: "invalid" };
  }
  const host = u.hostname.toLowerCase();
  if (SHORT_HOSTS.has(host)) return { ok: false, error: "short_link" };
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "invalid" };
  if (u.username || u.password || (u.port && u.port !== "443"))
    return { ok: false, error: "invalid" };
  if (!GOOGLE_HOSTS.has(host)) return { ok: false, error: "not_google" };
  // http:// kabul edilir; sonuç her zaman https olarak yeniden üretilir.

  const path = u.pathname.replace(/\/+$/, "");
  if (path === "/maps/embed") {
    // Ham (yüzde kodlu) değer: Google'ın pb metni %3A gibi kodlar içerir; çözülmüş hali
    // boşluk vb. karakterler içerebileceği için kodlu biçim olduğu gibi doğrulanıp kullanılır.
    const pb = u.search.match(/[?&]pb=([^&#]*)/)?.[1];
    if (pb && pb.length <= PB_MAX && PB_RE.test(pb)) {
      return { ok: true, url: `https://www.google.com/maps/embed?pb=${pb}` };
    }
    return { ok: false, error: "invalid" };
  }
  if (path === "/maps" || path.startsWith("/maps/")) {
    const r = fromShareUrl(u);
    return r ? { ok: true, url: r } : { ok: false, error: "no_location" };
  }
  return { ok: false, error: "not_google" };
}

/**
 * Kayıtlı adres gösterimden önce yeniden doğrulanır: yalnız iki kalıptan biriyse ve yeniden
 * ayrıştırıldığında AYNI sonucu veriyorsa kullanılır; aksi halde null (harita gösterilmez).
 */
export function safeMapEmbedUrl(stored: string | null | undefined): string | null {
  if (!stored || !DB_RE.test(stored)) return null;
  const r = parseMapInput(stored);
  return r.ok && r.url === stored ? stored : null;
}

/** "Google Haritalar'da aç" bağlantısı: koordinat varsa (q= kalıbı veya pb içindeki merkez). */
export function mapOpenUrl(embedUrl: string): string | null {
  const q = embedUrl.match(/\?q=(-?[0-9.]+),(-?[0-9.]+)&/);
  if (q) return `https://www.google.com/maps/search/?api=1&query=${q[1]},${q[2]}`;
  const pb = embedUrl.match(/!2d(-?\d{1,3}(?:\.\d+)?)!3d(-?\d{1,2}(?:\.\d+)?)/);
  if (pb) return `https://www.google.com/maps/search/?api=1&query=${pb[2]},${pb[1]}`;
  return null;
}
