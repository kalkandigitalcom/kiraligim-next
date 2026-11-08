/**
 * iCal entegrasyonu (3.1): sabitler, etiketler ve saf yardımcılar. Bağımlılıksız: Drizzle şeması,
 * veritabanı kısıtları, servisler, panel ve testler aynı değerleri kullanır.
 *
 * Model:
 *  - İçe aktarma: mülk başına birden fazla harici takvim kaynağı (Airbnb, Booking.com, …). Kaynaktan
 *    gelen dolu aralıklar AYRI tabloda (external_calendar_events) tutulur; rezervasyon tablosuna
 *    sahte kayıt yazılmaz. Etkin kaynağın etkin olayları yeni rezervasyon/blokla çakışamaz.
 *  - Dışa aktarma: mülk başına gizli adresli bir .ics akışı. Yalnız Kiraligim'in kendi kayıtları
 *    (beklemede + onaylı rezervasyon ve bloklar) gider; harici olaylar hiçbir zaman geri gönderilmez.
 */

/** Varsayılan otomatik senkron aralığı. */
export const ICAL_SYNC_INTERVAL_HOURS = 4;

export const ICAL_LIMITS = {
  sourcesPerProperty: 10,
  nameMin: 1,
  nameMax: 60,
  urlMax: 2048,
  uidMax: 255,
  /** Bir akıştan alınacak en fazla olay (fazlası hata: too_many_events). */
  maxEvents: 2000,
  /** Yanıt gövdesi sınırı (bayt). */
  maxBytes: 2 * 1024 * 1024,
  /** İstek zaman aşımı (ms). */
  timeoutMs: 15_000,
  maxRedirects: 3,
  /** Elle senkron için iki deneme arası en az süre (sn). */
  manualCooldownSeconds: 60,
  /** Kaynak kilidi süresi (sn): takılan bir senkronun kilidi bu süre sonunda düşer. */
  lockSeconds: 120,
  /** Kaynak başına tutulan son senkron kaydı. */
  runsKept: 20,
  /** Cron çalıştırması başına en fazla kaynak ve eşzamanlılık. */
  batchSize: 50,
  concurrency: 4,
} as const;

/** Dışa aktarma akışının kapsamı (giriş penceresiyle aynı ufuk). */
export const ICAL_EXPORT_WINDOW = { pastDays: 30, futureYears: 3 } as const;

/** Dışa aktarılan olayların UID alan adı; içe aktarmada kendi olaylarımızı tanımak için. */
export const ICAL_UID_DOMAIN = "kiraligim.com";

export const isOwnExportUid = (uid: string) => uid.toLowerCase().endsWith(`@${ICAL_UID_DOMAIN}`);

export const ICAL_SOURCE_STATUSES = ["pending", "ok", "error"] as const;
export type IcalSourceStatus = (typeof ICAL_SOURCE_STATUSES)[number];

export const ICAL_SYNC_TRIGGERS = ["cron", "manual"] as const;
export type IcalSyncTrigger = (typeof ICAL_SYNC_TRIGGERS)[number];

/** Senkron hata kodları (veritabanına kod yazılır; mesaj uygulamada üretilir). */
export const ICAL_ERROR_CODES = [
  "invalid_url",
  "blocked_address",
  "dns",
  "timeout",
  "network",
  "http_status",
  "too_large",
  "not_ical",
  "too_many_events",
  "internal",
] as const;
export type IcalErrorCode = (typeof ICAL_ERROR_CODES)[number];

export const ICAL_ERROR_MESSAGES: Record<IcalErrorCode, string> = {
  invalid_url: "Adres geçerli bir iCal bağlantısı değil.",
  blocked_address: "Bu adrese güvenlik nedeniyle erişilemez (yerel veya özel ağ).",
  dns: "Adres çözümlenemedi; bağlantıyı kontrol edin.",
  timeout: "Takvim zamanında yanıt vermedi.",
  network: "Takvime bağlanılamadı.",
  http_status: "Takvim sunucusu hata döndürdü (bağlantı geçersiz veya süresi dolmuş olabilir).",
  too_large: "Takvim dosyası çok büyük.",
  not_ical: "Adres bir iCal takvimi döndürmedi.",
  too_many_events: "Takvimde çok fazla etkinlik var.",
  internal: "Senkron sırasında beklenmeyen bir hata oluştu.",
};

export const isIcalErrorCode = (v: unknown): v is IcalErrorCode =>
  typeof v === "string" && (ICAL_ERROR_CODES as readonly string[]).includes(v);

export const ICAL_SOURCE_STATUS_LABELS: Record<IcalSourceStatus, string> = {
  pending: "Henüz senkron edilmedi",
  ok: "Senkron başarılı",
  error: "Son senkron başarısız",
};

/** Kaynak adı için hazır öneriler (serbest metin de olur). */
export const ICAL_SOURCE_PRESETS = ["Airbnb", "Booking.com", "Vrbo", "Google Takvim"] as const;

/**
 * Kullanıcının yapıştırdığı adres → istek adresi. `webcal://` → `https://`; boşluk kırpılır.
 * Yalnız http(s), kullanıcı adı/parola içermeyen, 80/443 dışında port kullanmayan adresler.
 * Ağ denetimi (özel IP, DNS) ayrıca sunucuda yapılır (src/server/ical/fetch.ts).
 */
export function normalizeIcalUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > ICAL_LIMITS.urlMax) return null;
  const withScheme = /^webcals?:\/\//i.test(raw) ? raw.replace(/^webcals?:\/\//i, "https://") : raw;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  if (!u.hostname || u.hostname.length > 253) return null;
  u.hash = "";
  const out = u.toString();
  return out.length <= ICAL_LIMITS.urlMax ? out : null;
}

/**
 * Panelde gösterim için adresin gizli kısmını maskeler: yalnız şema + host + yolun ilk parçası.
 * (Platform adresleri erişim anahtarı içerir; tam adres yalnız düzenleme formunda görünür.)
 */
export function maskIcalUrl(url: string): string {
  try {
    const u = new URL(url);
    const first = u.pathname.split("/").filter(Boolean)[0];
    return `${u.protocol}//${u.host}/${first ? `${first}/…` : ""}`;
  } catch {
    return "…";
  }
}

/** Dışa aktarma adresi: APP_URL/api/ical/<token>.ics */
export const icalExportUrl = (appUrl: string, token: string) =>
  new URL(`/api/ical/${token}.ics`, appUrl).toString();

/** 32 bayt base64url → 43 karakter. */
export const ICAL_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const SYNC_TIME_FMT = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Senkron zamanı (Europe/Istanbul): "8 Kasım 2026 14:05"; yoksa "Henüz yok". */
export const formatSyncTime = (v: Date | string | null) =>
  v === null ? "Henüz yok" : SYNC_TIME_FMT.format(new Date(v));
