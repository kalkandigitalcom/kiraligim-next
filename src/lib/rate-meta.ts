/**
 * Fiyat dönemleri (Aşama 3.1): sabitler ve saf yardımcılar. Bağımlılıksız: Drizzle şeması, Zod,
 * servis ve tarayıcı (form, liste) aynı değerleri kullanır. Veritabanı CHECK'leri aynı sınırlarla
 * yazılmıştır (drizzle/0017, 0018).
 *
 * Dönem, rezervasyonlarla aynı biçimde [başlangıç, bitiş) yarı açık aralıktır ve GECELERİ kapsar:
 * "1 Temmuz – 16 Temmuz" dönemi 1–15 Temmuz gecelerini içerir; 16 Temmuz bir sonraki dönemin
 * başlangıcı olabilir. Aynı mülkte dönemler kesişemez (veritabanı exclusion constraint'i).
 *
 * Bir dönemde gecelik fiyat, haftalık fiyat (o dönemde geçerli 7 gecelik toplam) ya da ikisi
 * birlikte bulunur; en az biri zorunludur. Bu aşamada fiyatlardan konaklama tutarı HESAPLANMAZ:
 * haftalık fiyatın kısa/uzun konaklamalara uygulanma kuralları ayrıca tanımlanacaktır.
 */
import { addDays, type Currency, nightsBetween } from "./reservation-meta";

export const RATE_LIMITS = {
  /** Bir dönem en fazla bu kadar gece (artık yıl dahil tam bir yıl). */
  maxNights: 366,
  minNightsMin: 1,
  minNightsMax: 365,
  /** Tutar üst sınırı (kuruş/sent): 9.999.999.999,99 — rezervasyon tutarlarıyla aynı. */
  amountMaxMinor: 999_999_999_999,
  /** Haftalık fiyatın kapsadığı gece sayısı. */
  weekNights: 7,
} as const;

/** Fiyat dönemi (istemciye giden biçim: yalnız fiyat verisi; oluşturan kullanıcı bilgisi yok). */
export type RatePeriod = {
  id: string;
  startDate: string;
  /** Hariç: bu gün bir sonraki dönemin başlangıcı olabilir. */
  endDate: string;
  nightlyAmountMinor: number | null;
  weeklyAmountMinor: number | null;
  currency: Currency;
  minNights: number | null;
};

/** Dönemin son gecesi (bitiş − 1 gün). */
export const lastNightOf = (p: Pick<RatePeriod, "endDate">) => addDays(p.endDate, -1);

export const periodNights = (p: Pick<RatePeriod, "startDate" | "endDate">) =>
  nightsBetween(p.startDate, p.endDate);

/** [start, end) aralığıyla kesişen dönemler (bitişik dönemler kesişmez). */
export function overlappingPeriods<P extends Pick<RatePeriod, "startDate" | "endDate">>(
  startDate: string,
  endDate: string,
  periods: readonly P[],
): P[] {
  return periods.filter((p) => p.startDate < endDate && p.endDate > startDate);
}

/** Dönemleri başlangıca göre sıralar (aynı başlangıç olamaz; yine de kimliğe göre kararlı). */
export function sortPeriods<P extends Pick<RatePeriod, "id" | "startDate">>(periods: readonly P[]) {
  return [...periods].sort((a, b) =>
    a.startDate === b.startDate ? a.id.localeCompare(b.id) : a.startDate < b.startDate ? -1 : 1,
  );
}

/**
 * Ardışık dönemler arasındaki fiyatsız geceler: [önceki bitiş, sonraki başlangıç). Listede
 * gösterilir; ör. "1–15 Temmuz" ve "16–31 Temmuz" bitiş günü dahil sanılarak girildiğinde
 * 15 Temmuz gecesi boşta kalır ve kullanıcı bunu hemen görür.
 */
export function periodGaps(periods: readonly Pick<RatePeriod, "id" | "startDate" | "endDate">[]) {
  const sorted = sortPeriods(periods);
  const gaps: { afterId: string; from: string; to: string; nights: number }[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const next = sorted[i]!;
    if (prev.endDate < next.startDate) {
      gaps.push({
        afterId: prev.id,
        from: prev.endDate,
        to: next.startDate,
        nights: nightsBetween(prev.endDate, next.startDate),
      });
    }
  }
  return gaps;
}

/**
 * Takvim altyapısı: bir gecenin (date gecesi) dönemini bulur; tanımsızsa null. İleride günlük
 * fiyat takvimi bu fonksiyonla çizilir. Konaklama tutarı HESAPLAMAZ.
 */
export function periodForNight<P extends Pick<RatePeriod, "startDate" | "endDate">>(
  date: string,
  periods: readonly P[],
): P | null {
  return periods.find((p) => p.startDate <= date && date < p.endDate) ?? null;
}

/** [from, to) aralığındaki her gece ve o gecenin dönemi (fiyat takvimi için). */
export function nightsWithPeriods<P extends Pick<RatePeriod, "startDate" | "endDate">>(
  from: string,
  to: string,
  periods: readonly P[],
): { date: string; period: P | null }[] {
  const out: { date: string; period: P | null }[] = [];
  for (let d = from; d < to; d = addDays(d, 1))
    out.push({ date: d, period: periodForNight(d, periods) });
  return out;
}

/** Haftalık fiyat 7 × gecelikten yüksek mi? (Uyarı içindir; haftalık fiyat yine kullanılır.) */
export const weeklyAboveNightly = (
  p: Pick<RatePeriod, "nightlyAmountMinor" | "weeklyAmountMinor">,
) =>
  p.nightlyAmountMinor !== null &&
  p.weeklyAmountMinor !== null &&
  p.weeklyAmountMinor > RATE_LIMITS.weekNights * p.nightlyAmountMinor;

/**
 * Aynı fiyatlı bitişik dönemler (önceki bitiş = sonraki başlangıç; gecelik, haftalık, para birimi
 * ve minimum aynı). Otomatik birleştirilmez; haftalık fiyatın dönem sınırında bölüneceği
 * kullanıcıya açıklanır. Döner: önceki dönemin kimlikleri.
 */
export function adjacentSamePrice(periods: readonly RatePeriod[]): string[] {
  const sorted = sortPeriods(periods);
  const out: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (
      a.endDate === b.startDate &&
      a.nightlyAmountMinor === b.nightlyAmountMinor &&
      a.weeklyAmountMinor === b.weeklyAmountMinor &&
      a.currency === b.currency &&
      a.minNights === b.minNights
    ) {
      out.push(a.id);
    }
  }
  return out;
}
