/**
 * Opsiyon Aşama 3c — Super Admin opsiyon paneli: saf yardımcılar (form ayrıştırma, kalan süre).
 * Bağımlılıksız; asıl denetimi veritabanı fonksiyonları yapar (drizzle/0067, 0069, 0071). Buradaki
 * ön denetim yalnız açık hatayı erken ve anlaşılır göstermek içindir.
 */
import { OPTION_LIMITS, OPTION_SETTINGS_LIMITS } from "./option-meta";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** Geçerli takvim günü (YYYY-AA-GG) ya da null. */
export function parseIsoDate(v: unknown): string | null {
  if (typeof v !== "string" || !ISO_DATE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

/** Pozitif tam sayı (boş → null; geçersiz → NaN). */
export function parseCount(v: unknown, max: number): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const t = v.trim();
  if (!/^\d{1,4}$/.test(t)) return Number.NaN;
  const n = Number(t);
  return n > max ? Number.NaN : n;
}

/**
 * Süre: "48" (saat) ya da "2g" / "2 gün" (gün). Sonuç dakika; 1 saat – 14 gün dışında NaN, boş null.
 */
export function parseDurationMinutes(v: unknown): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const t = v.trim().toLocaleLowerCase("tr-TR");
  const m = /^(\d{1,3})\s*(s|sa|saat|g|gün|gun)?$/.exec(t);
  if (!m) return Number.NaN;
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  const minutes = unit.startsWith("g") ? n * 24 * 60 : n * 60;
  if (minutes < OPTION_SETTINGS_LIMITS.minMinutes || minutes > OPTION_SETTINGS_LIMITS.maxMinutes) {
    return Number.NaN;
  }
  return minutes;
}

/** Süre seçenekleri: "24, 48, 3g" → dakika listesi (sıralı, tekil). Geçersiz bir değer → null. */
export function parseDurationChoices(v: unknown): number[] | null {
  if (typeof v !== "string" || v.trim() === "") return [];
  const parts = v
    .split(/[,;\n]/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const out = new Set<number>();
  for (const p of parts) {
    const m = parseDurationMinutes(p);
    if (m === null || Number.isNaN(m)) return null;
    out.add(m);
  }
  if (out.size > OPTION_SETTINGS_LIMITS.maxChoices) return null;
  return [...out].sort((a, b) => a - b);
}

/** Dakikayı okunur süreye çevirir: 1440 → "1 gün", 90 → "1 sa 30 dk", 2880 → "2 gün". */
export function formatMinutes(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return "—";
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d} gün`);
  if (h) parts.push(`${h} sa`);
  if (m) parts.push(`${m} dk`);
  return parts.length ? parts.join(" ") : "0 dk";
}

/** Form alanına geri yazılacak süre: 2880 → "2g", 2160 → "36" (saat). */
export function durationInput(minutes: number | null): string {
  if (minutes === null) return "";
  if (minutes % 1440 === 0) return `${minutes / 1440}g`;
  return String(Math.round(minutes / 60));
}

/** Kalan süre (saniye, sunucuda hesaplanır): "2 gün 3 sa", "45 dk", "süresi doldu". */
export function formatRemaining(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds <= 0) return "süresi doldu";
  const minutes = Math.max(1, Math.floor(seconds / 60));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d) return h ? `${d} gün ${h} sa` : `${d} gün`;
  if (h) return m ? `${h} sa ${m} dk` : `${h} sa`;
  return `${m} dk`;
}

/** Not alanı: kırpılır; boş → null; sınırı aşan → hata (undefined). */
export function parseNote(v: unknown): string | null | undefined {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "") return null;
  return t.length > OPTION_SETTINGS_LIMITS.noteMax ? undefined : t;
}

/** Misafir adı: kırpılır; boş → null; sınırı aşan → hata (undefined). */
export function parseGuestName(v: unknown): string | null | undefined {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  if (t === "") return null;
  return t.length > OPTION_LIMITS.guestNameMax ? undefined : t;
}
