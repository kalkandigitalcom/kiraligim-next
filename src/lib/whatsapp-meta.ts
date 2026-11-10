/**
 * WhatsApp Asistanı (A1: grup kaydı ve mesaj kuyruğu) — istemci ve sunucuda ortak sabitler ve
 * saf yardımcılar. Ağ geçidi (services/wa-gateway) aynı kod biçimini kendi kopyasıyla denetler;
 * iki taraf aynı test vektörlerini kullanır.
 */

/** Mesajların saklama süresi (gün). Süre dolunca mesaj satırı tümüyle silinir. */
export const WA_RETENTION_DAYS = 90;

/** Numara doğrulama kodu: 10 dakika geçerli, tek kullanımlık (asistana ÖZEL mesajla gönderilir). */
export const WA_LINK_CODE_TTL_MINUTES = 10;

/** Karışıklığa yol açan karakterler (0/O, 1/I) yok: 32 harf → 8 karakterde ~1,1 × 10^12. */
export const WA_LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const WA_LINK_CODE_LENGTH = 8;

/**
 * Asistana özel mesajla gönderilecek tam metin: "kiraligim doğrula 7Q4M-2XKD" ("doğrula", büyük/küçük
 * harf ve tire isteğe bağlı). Gruplara kod YAZILMAZ (kodsuz eşleştirme).
 */
const VERIFY_MESSAGE_RE =
  /^\s*k[ıiİI]ral[ıiİI][gğĞ][ıiİI]m\s+(?:do[gğĞ]rula\s+)?([a-z2-9]{4})-?([a-z2-9]{4})\s*$/i;

export function formatLinkCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

export function verifyMessage(raw: string): string {
  return `kiraligim doğrula ${formatLinkCode(raw)}`;
}

/** Mesajın tamamı doğrulama kodu mu? Evet ise normalize kodu (8 büyük harf) döner. */
export function parseVerifyMessage(text: string): string | null {
  const m = VERIFY_MESSAGE_RE.exec(text);
  if (!m) return null;
  const code = `${m[1]}${m[2]}`.toUpperCase();
  return [...code].every((c) => WA_LINK_CODE_ALPHABET.includes(c)) ? code : null;
}

/** Rastgele bağlama kodu (yalnız sunucuda çağrılır; modulo yanlılığı yok: 256 % 32 = 0). */
export function generateLinkCode(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(WA_LINK_CODE_LENGTH);
  let out = "";
  for (const b of bytes) out += WA_LINK_CODE_ALPHABET[b % WA_LINK_CODE_ALPHABET.length];
  return out;
}

/**
 * Telefonu ülke koduyla yalnız rakama çevirir ("+90 532 111 22 33" → "905321112233").
 * Başında 0 olan yerel Türkiye numarası (0532…) 90 ile tamamlanır. Geçersizse null.
 */
export function normalizePhone(input: string): string | null {
  let d = input.replace(/[\s()+.-]/g, "");
  if (!/^[0-9]+$/.test(d)) return null;
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0") && d.length === 11) d = `90${d.slice(1)}`;
  return /^[1-9][0-9]{9,14}$/.test(d) ? d : null;
}

/**
 * Asistana özel mesaj bağlantısı (WhatsApp'ta sohbeti metin hazır açar; kullanıcı yalnız gönderir).
 * Numara geçersizse null.
 */
export function waMeLink(accountPn: string | null | undefined, text: string): string | null {
  if (!accountPn || !/^[1-9][0-9]{6,19}$/.test(accountPn)) return null;
  return `https://wa.me/${accountPn}?text=${encodeURIComponent(text)}`;
}

/** "905321112233" → "+90 532 *** ** 33". */
export function maskPhone(num: string | null | undefined): string {
  if (!num) return "gizli kimlik";
  if (num.length < 8) return "***";
  return `+${num.slice(0, 2)} ${num.slice(2, 5)} *** ** ${num.slice(-2)}`;
}

export const WA_GROUP_STATUSES = ["discovered", "linked", "suspended", "left"] as const;
export type WaGroupStatus = (typeof WA_GROUP_STATUSES)[number];

export const WA_GROUP_STATUS_LABELS: Record<WaGroupStatus, string> = {
  discovered: "Bağlı değil",
  linked: "Aktif",
  suspended: "Askıda",
  left: "Ayrıldı",
};

export const WA_CONNECTION_STATUSES = ["connecting", "open", "closed", "logged_out"] as const;
export type WaConnectionStatus = (typeof WA_CONNECTION_STATUSES)[number];

export const WA_CONNECTION_STATUS_LABELS: Record<WaConnectionStatus, string> = {
  connecting: "Bağlanıyor",
  open: "Bağlı",
  closed: "Bağlantı yok",
  logged_out: "Oturum kapandı",
};

/** Kalp atışı bu süreden eskiyse bağlantı "yok" sayılır (dakika). */
export const WA_STALE_MINUTES = 15;

/** Panelden grup eşleştirme sonucu (app_wa_claim_group). */
export const WA_CLAIM_OUTCOMES = [
  "linked",
  "forbidden",
  "not_verified",
  "not_found",
  "property_not_found",
] as const;
export type WaClaimOutcome = (typeof WA_CLAIM_OUTCOMES)[number];

/* ── Takvim önerileri (A2: wa_calendar_proposals, drizzle/0035–0036) ───────── */

/**
 * Gelen mesajın kuyruk durumu. received → processing (worker işi aldı) → processed (öneri yazıldı)
 * | ignored (takvimle ilgisiz, geçmiş birikim, eski ya da worker öncesi mesaj) | failed (deneme
 * sınırı aşıldı).
 */
export const WA_INBOUND_STATUSES = [
  "received",
  "processing",
  "processed",
  "ignored",
  "failed",
] as const;
export type WaInboundStatus = (typeof WA_INBOUND_STATUSES)[number];

/**
 * Önerinin durumu. Yalnız "pending" değişebilir. applied/rejected yalnız oturumdaki yönetici
 * tarafından; superseded/expired/noop yalnız veritabanı fonksiyonlarıyla (worker, temizlik).
 */
export const WA_PROPOSAL_STATUSES = [
  "pending",
  "applied",
  "rejected",
  "superseded",
  "expired",
  "noop",
] as const;
export type WaProposalStatus = (typeof WA_PROPOSAL_STATUSES)[number];

/** Villa çözümü (ayrıştırıcının VillaResolution tipiyle aynı değerler). */
export const WA_VILLA_RESOLUTIONS = ["named", "single", "ambiguous", "none"] as const;

/** Onay biçimi: quick yalnız nedensiz kapatma; diğer her şey reviewed (veritabanı CHECK'i). */
export const WA_DECISION_MODES = ["quick", "reviewed"] as const;
export type WaDecisionMode = (typeof WA_DECISION_MODES)[number];

/** Worker ve öneri sınırları (veritabanı fonksiyonları aynı değerlerle yazılmıştır). */
export const WA_PROPOSAL_LIMITS = {
  /** Bir çalıştırmada en fazla alınacak mesaj. */
  claimBatchMax: 50,
  /** İş kilidi süresi (sn): dolan kilit bir sonraki çalıştırmada yeniden alınır. */
  lockSeconds: 120,
  /** Bu kadar denemeden sonra mesaj "failed" olur. */
  maxAttempts: 5,
  /** Gönderimi bundan eski mesajlar öneri üretmez (gün). */
  maxMessageAgeDays: 7,
  /** Mesaj başına en fazla öneri (WA_CALENDAR_MAX_ITEMS ile aynı). */
  itemsPerMessage: 10,
  excerptMax: 500,
  villaNameMax: 120,
  decisionNoteMax: 500,
  /** Bayrak, neden ve kimlik dizilerinin en fazla eleman sayısı. */
  arrayMax: 20,
} as const;

/** Saklama süresi dolan karar verilmiş önerilerde mesaj alıntısının yerine yazılan metin. */
export const WA_PROPOSAL_EXCERPT_PURGED = "(silindi)";
