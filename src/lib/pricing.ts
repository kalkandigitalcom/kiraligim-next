/**
 * Konaklama fiyat hesabı (Aşama 3.2). Saf ve bağımlılıksız: sunucu (asıl hesap) ve tarayıcı aynı
 * fonksiyonu kullanır. SALT OKUNUR: hiçbir kaydı değiştirmez; sonuç yalnız ev sahibi "Bu tutarı
 * kullan" dediğinde rezervasyon formuna aktarılır.
 *
 * Kurallar (iş kararları, 3.2):
 *  1. Konaklama [giriş, çıkış) geceleridir; her gece kendi fiyat döneminin kurallarıyla hesaplanır.
 *  2. Aynı döneme düşen ardışık geceler bir "parça"dır. Dönemde haftalık fiyat varsa parça içinde
 *     ⌊gece / 7⌋ haftalık blok, kalan geceler gecelik fiyatla. Haftalık blok dönem sınırını AŞMAZ.
 *     Haftalık fiyat 7 × gecelikten pahalı olsa da tanımlanan haftalık fiyat kullanılır.
 *  3. Tek bir gecenin fiyatı bile bulunamazsa (dönem yok ya da kalan geceler için gecelik fiyat yok)
 *     toplam HESAPLANMAZ.
 *  4. Minimum konaklama: GİRİŞ gecesinin dönemindeki değer esas alınır; ihlal yalnız uyarıdır.
 *  5. Bir mülkün dönemleri tek para birimindedir (veritabanı kuralı, 0019); yine de farklı para
 *     birimi görülürse hesaplanmaz.
 * Tutarlar kuruş/sent tam sayıdır; yuvarlama yoktur.
 */
import { formatNights, type RatePeriod } from "./rate-meta";
import {
  addDays,
  type Currency,
  formatMoney,
  formatStay,
  nightsBetween,
  RESERVATION_LIMITS,
} from "./reservation-meta";

export const WEEK_NIGHTS = 7;

export type QuoteSegment = {
  periodId: string;
  from: string;
  /** Hariç. */
  to: string;
  nights: number;
  /** Haftalık blok sayısı (dönemde haftalık fiyat yoksa 0). */
  weeks: number;
  weeklyAmountMinor: number | null;
  /** Gecelik fiyatla hesaplanan geceler. */
  extraNights: number;
  nightlyAmountMinor: number | null;
  /** Parça tutarı; kalan geceler için gecelik fiyat yoksa null. */
  subtotalMinor: number | null;
};

export type QuoteIssue =
  /** Bu gecelere dönem tanımlı değil. */
  | { kind: "unpriced"; from: string; to: string; nights: number }
  /** Dönemde gecelik fiyat yok; haftalık bloklara sığmayan geceler fiyatlanamıyor. */
  | { kind: "nightly-missing"; periodId: string; from: string; to: string; nights: number }
  | { kind: "currency-mismatch" }
  /** Toplam rezervasyon tutar sınırını aşıyor. */
  | { kind: "too-large" };

export type Quote = {
  checkIn: string;
  checkOut: string;
  nights: number;
  ok: boolean;
  totalMinor: number | null;
  currency: Currency | null;
  segments: QuoteSegment[];
  issues: QuoteIssue[];
  /** Giriş gecesinin döneminin minimum konaklaması karşılanmıyorsa (uyarı; engellemez). */
  minNights: { required: number; periodId: string } | null;
};

type PeriodInput = Pick<
  RatePeriod,
  | "id"
  | "startDate"
  | "endDate"
  | "nightlyAmountMinor"
  | "weeklyAmountMinor"
  | "currency"
  | "minNights"
>;

export function quoteStay(
  checkIn: string,
  checkOut: string,
  periods: readonly PeriodInput[],
): Quote {
  const nights = nightsBetween(checkIn, checkOut);
  const segments: (QuoteSegment & { period: PeriodInput })[] = [];
  const issues: QuoteIssue[] = [];

  // 1. Gece gece dönem eşle; aynı döneme düşen ardışık geceleri birleştir.
  let gap: { from: string; to: string; nights: number } | null = null;
  const flushGap = () => {
    if (gap) issues.push({ kind: "unpriced", ...gap });
    gap = null;
  };
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) {
    const p = periods.find((x) => x.startDate <= d && d < x.endDate);
    if (!p) {
      if (gap) {
        gap.to = addDays(d, 1);
        gap.nights++;
      } else gap = { from: d, to: addDays(d, 1), nights: 1 };
      continue;
    }
    flushGap();
    const last = segments.at(-1);
    if (last && last.period.id === p.id && last.to === d) {
      last.to = addDays(d, 1);
      last.nights++;
    } else {
      segments.push({
        period: p,
        periodId: p.id,
        from: d,
        to: addDays(d, 1),
        nights: 1,
        weeks: 0,
        weeklyAmountMinor: p.weeklyAmountMinor,
        extraNights: 0,
        nightlyAmountMinor: p.nightlyAmountMinor,
        subtotalMinor: null,
      });
    }
  }
  flushGap();

  // 2. Parça fiyatları: haftalık bloklar yalnız parça içinde.
  let total = 0;
  for (const s of segments) {
    s.weeks = s.weeklyAmountMinor !== null ? Math.floor(s.nights / WEEK_NIGHTS) : 0;
    s.extraNights = s.nights - s.weeks * WEEK_NIGHTS;
    if (s.extraNights > 0 && s.nightlyAmountMinor === null) {
      issues.push({
        kind: "nightly-missing",
        periodId: s.periodId,
        from: addDays(s.from, s.weeks * WEEK_NIGHTS),
        to: s.to,
        nights: s.extraNights,
      });
      s.subtotalMinor = null;
      continue;
    }
    s.subtotalMinor =
      s.weeks * (s.weeklyAmountMinor ?? 0) + s.extraNights * (s.nightlyAmountMinor ?? 0);
    total += s.subtotalMinor;
  }

  const currencies = new Set(segments.map((s) => s.period.currency));
  if (currencies.size > 1) issues.push({ kind: "currency-mismatch" });
  const priceable = issues.length === 0;
  if (priceable && total > RESERVATION_LIMITS.amountMaxMinor) issues.push({ kind: "too-large" });

  // 3. Minimum konaklama: giriş gecesinin dönemi.
  const first = periods.find((x) => x.startDate <= checkIn && checkIn < x.endDate);
  const minNights =
    first?.minNights != null && nights < first.minNights
      ? { required: first.minNights, periodId: first.id }
      : null;

  const ok = issues.length === 0 && segments.length > 0;
  return {
    checkIn,
    checkOut,
    nights,
    ok,
    totalMinor: ok ? total : null,
    currency: currencies.size === 1 ? [...currencies][0]! : null,
    segments: segments.map(({ period: _p, ...s }) => s),
    issues,
    minNights,
  };
}

/** Bir parçanın hesabı: "1 hafta × €35.000,00 + 3 gece × €5.000,00". */
export function segmentFormula(s: QuoteSegment, currency: Currency): string {
  const parts: string[] = [];
  if (s.weeks > 0 && s.weeklyAmountMinor !== null) {
    parts.push(`${s.weeks} hafta × ${formatMoney(s.weeklyAmountMinor, currency)}`);
  }
  if (s.extraNights > 0) {
    parts.push(
      s.nightlyAmountMinor === null
        ? `${s.extraNights} gece × (fiyat yok)`
        : `${s.extraNights} gece × ${formatMoney(s.nightlyAmountMinor, currency)}`,
    );
  }
  return parts.join(" + ");
}

/** Fiyatı olmayan gecelerin okunur özeti (geceler dahil): "1–2 Ağustos 2027 (2 gece)". */
export function unpricedSummary(q: Quote): string {
  return q.issues
    .flatMap((i) =>
      i.kind === "unpriced" || i.kind === "nightly-missing"
        ? [`${formatNights(i.from, i.to)} (${i.nights} gece)`]
        : [],
    )
    .join(", ");
}

/**
 * Misafire gönderilecek hazır teklif metni (Kopyala / WhatsApp). Misafir adı veya iletişim
 * bilgisi içermez. Toplam hesaplanamıyorsa null.
 */
export function quoteMessage(q: Quote, propertyName: string): string | null {
  if (!q.ok || q.totalMinor === null || q.currency === null) return null;
  const c = q.currency;
  const lines = q.segments.map(
    (s) =>
      `• ${formatNights(s.from, s.to)} (${s.nights} gece): ${segmentFormula(s, c)} = ${formatMoney(s.subtotalMinor ?? 0, c)}`,
  );
  return [
    "Merhaba,",
    "",
    `${propertyName} için ${formatStay(q.checkIn, q.checkOut)} (${q.nights} gece) konaklama teklifimiz:`,
    "",
    ...lines,
    "",
    `Toplam: ${formatMoney(q.totalMinor, c)}`,
    "",
    "Fiyatlar konaklama tarihlerine göre hesaplanmıştır. Rezervasyon için bize yanıt verebilirsiniz.",
  ].join("\n");
}
