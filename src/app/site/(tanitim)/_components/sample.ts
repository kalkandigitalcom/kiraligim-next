import type { RatePeriod } from "@/lib/rate-meta";

/**
 * Tanıtım sitesindeki örnek mülk ve fiyat dönemleri (KURGUSAL). Hesaplayıcı ve ürün görselleri
 * bu verilerle panelin kullandığı aynı motoru (src/lib/pricing.ts → quoteStay) çalıştırır.
 */
export const SAMPLE_PROPERTY = "Villa Defne";

const TL = (n: number) => n * 100;

export const SAMPLE_PERIODS: RatePeriod[] = [
  {
    id: "ornek-ilkbahar",
    startDate: "2027-04-01",
    endDate: "2027-06-01",
    nightlyAmountMinor: TL(6500),
    weeklyAmountMinor: TL(42000),
    currency: "TRY",
    minNights: 3,
    cleaningFeeMinor: TL(2500),
    cleaningFeeFreeNights: 7,
  },
  {
    id: "ornek-haziran",
    startDate: "2027-06-01",
    endDate: "2027-07-01",
    nightlyAmountMinor: TL(8500),
    weeklyAmountMinor: TL(55000),
    currency: "TRY",
    minNights: 5,
    cleaningFeeMinor: TL(2500),
    cleaningFeeFreeNights: 7,
  },
  {
    id: "ornek-yaz",
    startDate: "2027-07-01",
    endDate: "2027-09-01",
    nightlyAmountMinor: TL(11000),
    weeklyAmountMinor: TL(70000),
    currency: "TRY",
    minNights: 7,
    cleaningFeeMinor: TL(3000),
    cleaningFeeFreeNights: 7,
  },
  {
    id: "ornek-sonbahar",
    startDate: "2027-09-01",
    endDate: "2027-11-01",
    nightlyAmountMinor: TL(7500),
    weeklyAmountMinor: TL(48000),
    currency: "TRY",
    minNights: 3,
    cleaningFeeMinor: TL(2500),
    cleaningFeeFreeNights: 7,
  },
];

export const SAMPLE_SEASON_LABELS: Record<string, string> = {
  "ornek-ilkbahar": "İlkbahar",
  "ornek-haziran": "Haziran",
  "ornek-yaz": "Yüksek sezon",
  "ornek-sonbahar": "Sonbahar",
};

/** Hesaplayıcı hazır seçimleri. */
export const SAMPLE_PRESETS = [
  {
    key: "hafta-yaz",
    label: "10 gece, yüksek sezon",
    checkIn: "2027-07-03",
    checkOut: "2027-07-13",
  },
  { key: "kisa", label: "5 gece, Haziran", checkIn: "2027-06-14", checkOut: "2027-06-19" },
  { key: "gecis", label: "Dönem geçişi", checkIn: "2027-06-27", checkOut: "2027-07-05" },
  { key: "iki-hafta", label: "2 hafta, Eylül", checkIn: "2027-09-04", checkOut: "2027-09-18" },
  { key: "fiyatsiz", label: "Fiyatı tanımsız gece", checkIn: "2027-10-28", checkOut: "2027-11-03" },
] as const;

export const SAMPLE_RANGE = { min: "2027-04-01", max: "2027-12-01" } as const;
