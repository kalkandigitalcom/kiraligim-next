import type { CalendarTone } from "@/lib/calendar";

/**
 * Takvim sınıf eşlemeleri. Tailwind sınıfları derleme anında kaynak metinden toplar; bu yüzden
 * sütun konumları dinamik birleştirme ("col-start-" + n) yerine sabit tablolardan seçilir.
 * Inline style yok (CSP).
 *
 * Hafta satırı 14 sütunlu ızgaradır: her gün iki yarım (sabah | akşam).
 */

/** Gün hücresi i (Pazartesi = 0) → 2i+1. sütundan başlar, iki sütun kaplar. */
export const DAY_COL = [
  "col-start-1",
  "col-start-3",
  "col-start-5",
  "col-start-7",
  "col-start-9",
  "col-start-11",
  "col-start-13",
] as const;

/** Şerit başlangıcı: yarım-gün s (0–13) → col-start-(s+1). */
export const HALF_START = [
  "col-start-1",
  "col-start-2",
  "col-start-3",
  "col-start-4",
  "col-start-5",
  "col-start-6",
  "col-start-7",
  "col-start-8",
  "col-start-9",
  "col-start-10",
  "col-start-11",
  "col-start-12",
  "col-start-13",
  "col-start-14",
] as const;

/** Şerit bitişi (hariç): yarım-gün e (1–14) → col-end-(e+1). İndeks 0 kullanılmaz. */
export const HALF_END = [
  "col-end-1",
  "col-end-2",
  "col-end-3",
  "col-end-4",
  "col-end-5",
  "col-end-6",
  "col-end-7",
  "col-end-8",
  "col-end-9",
  "col-end-10",
  "col-end-11",
  "col-end-12",
  "col-end-13",
  "col-end-14",
  "col-end-15",
] as const;

/** Şerit ve lejant renkleri; beklemede kesik kenarlık, blok çapraz tarama (renk + desen). */
export const TONE_BAR: Record<CalendarTone, string> = {
  confirmed: "bg-turquoise-700 text-white",
  pending: "border border-dashed border-amber-600 bg-amber-100 text-amber-900",
  block: "cal-block border border-navy-900/25 text-navy-900",
};

export const TONE_LABEL: Record<CalendarTone, string> = {
  confirmed: "Onaylı",
  pending: "Beklemede",
  block: "Blok",
};
