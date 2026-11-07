/**
 * Fotoğraf sınırları. Bağımlılıksız: sunucu (sharp, veritabanı şeması) ve tarayıcı (yükleme
 * formunun ön denetimi) aynı değerleri kullanır. Veritabanı CHECK'leri ve 80 sınırı tetikleyicisi
 * de aynı değerlerle yazılmıştır (drizzle/0011, 0012).
 */
export const PHOTO_LIMITS = {
  /** Mülk başına en fazla fotoğraf. */
  perProperty: 80,
  /** Yüklenen tek dosya (orijinal) en fazla 15 MB. */
  maxInputBytes: 15 * 1024 * 1024,
  /** Üretilen her WebP varyantı en fazla 5 MB. */
  maxVariantBytes: 5 * 1024 * 1024,
  /** Dekompresyon bombasına karşı en fazla piksel (≈ 50 MP; 48/50 MP telefon kameraları geçer). */
  maxInputPixels: 50_000_000,
  /** Varyant genişlikleri (px). Küçük görseller büyütülmez. */
  widths: [400, 1200, 2000] as const,
  maxWidth: 2000,
  /** WebP'nin desteklediği en büyük kenar. */
  maxDimension: 16383,
  /** Kalite basamakları: varyant 5 MB'ı aşarsa sırayla düşürülür; en düşükte de aşarsa red. */
  qualities: [82, 74, 66, 58] as const,
} as const;

export type PhotoWidth = (typeof PHOTO_LIMITS.widths)[number];

/** Kullanıcının seçebileceği dosyalar (ön denetim; asıl karar dosya baytlarına göre sunucuda). */
export const PHOTO_ACCEPT = ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp";
export const PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const PHOTO_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"] as const;

export function isAcceptedPhotoFile(file: { name: string; type: string }): boolean {
  const name = file.name.toLowerCase();
  const extOk = PHOTO_EXTENSIONS.some((e) => name.endsWith(e));
  const typeOk = (PHOTO_MIME_TYPES as readonly string[]).includes(file.type);
  return extOk || typeOk;
}

export const formatMb = (bytes: number) =>
  `${(bytes / (1024 * 1024)).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} MB`;
