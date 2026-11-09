/**
 * WhatsApp Asistanı (A1: grup kaydı ve mesaj kuyruğu) — istemci ve sunucuda ortak sabitler ve
 * saf yardımcılar. Ağ geçidi (services/wa-gateway) aynı kod biçimini kendi kopyasıyla denetler;
 * iki taraf aynı test vektörlerini kullanır.
 */

/** Mesajların saklama süresi (gün). Süre dolunca mesaj satırı tümüyle silinir. */
export const WA_RETENTION_DAYS = 90;

/** Grup bağlama kodu: 10 dakika geçerli, tek kullanımlık. */
export const WA_LINK_CODE_TTL_MINUTES = 10;

/** Karışıklığa yol açan karakterler (0/O, 1/I) yok: 32 harf → 8 karakterde ~1,1 × 10^12. */
export const WA_LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const WA_LINK_CODE_LENGTH = 8;

/** Gruba yazılacak tam mesaj: "kiraligim 7Q4M-2XKD" (büyük/küçük harf ve tire isteğe bağlı). */
const LINK_MESSAGE_RE = /^\s*k[ıiİI]ral[ıiİI][gğĞ][ıiİI]m\s+([a-z2-9]{4})-?([a-z2-9]{4})\s*$/i;

export function formatLinkCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

export function linkMessage(raw: string): string {
  return `kiraligim ${formatLinkCode(raw)}`;
}

/** Mesajın tamamı bağlama kodu mu? Evet ise normalize kodu (8 büyük harf) döner. */
export function parseLinkMessage(text: string): string | null {
  const m = LINK_MESSAGE_RE.exec(text);
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

/** Ağ geçidinin bağlama kodu sonucuna verdiği yanıtlar (yalnız `linked` için ✅). */
export const WA_REDEEM_OUTCOMES = [
  "linked",
  "invalid",
  "sender_unknown",
  "sender_mismatch",
  "not_permitted",
  "already_linked",
  "linked_elsewhere",
  "throttled",
  "unknown_group",
] as const;
export type WaRedeemOutcome = (typeof WA_REDEEM_OUTCOMES)[number];
