import "server-only";

import sharp, { type Metadata, type OutputInfo } from "sharp";

import { PHOTO_LIMITS, type PhotoWidth } from "@/lib/photo-meta";

/**
 * Fotoğraf işleme (sharp). Sunucu: x86_64, 3.7 GB RAM, swap yok → bellek ve CPU sınırlı tutulur:
 *  - libvips tek iş parçacığı, önbellek kapalı;
 *  - aynı anda tek görsel (kuyruk: src/server/media/queue.ts);
 *  - görsel bir kez 2000 px'e indirilip HAM piksel verisine çevrilir; varyantlar bu küçük ara
 *    görüntüden üretilir. Ham veri metadata taşımadığı için EXIF/GPS/XMP/ICC kesin olarak düşer.
 * Orijinal dosya yalnız bu fonksiyonun belleğinde yaşar; diske veya depolamaya yazılmaz.
 */
sharp.concurrency(1);
sharp.cache(false);

export type ImageRejectReason =
  | "unsupported_format"
  | "animated"
  | "too_many_pixels"
  | "dimensions"
  | "corrupt"
  | "output_too_large";

export class ImageRejectedError extends Error {
  constructor(
    readonly reason: ImageRejectReason,
    message: string,
  ) {
    super(message);
    this.name = "ImageRejectedError";
  }
}

export const IMAGE_REJECT_MESSAGES: Record<ImageRejectReason, string> = {
  unsupported_format: "Yalnız JPG, JPEG, PNG ve WebP fotoğraflar yüklenebilir.",
  animated: "Hareketli görseller desteklenmiyor.",
  too_many_pixels: "Fotoğrafın çözünürlüğü çok yüksek (en fazla 50 megapiksel).",
  dimensions: "Fotoğrafın en veya boyu desteklenen sınırın dışında.",
  corrupt: "Dosya okunamadı; bozuk olabilir.",
  output_too_large:
    "Fotoğraf işlendikten sonra 5 MB sınırını aşıyor. Daha düşük çözünürlüklü bir fotoğraf deneyin.",
};

const reject = (reason: ImageRejectReason) =>
  new ImageRejectedError(reason, IMAGE_REJECT_MESSAGES[reason]);

export type SniffedFormat = "jpeg" | "png" | "webp";

/** Uzantıya veya Content-Type'a güvenmeden, dosyanın ilk baytlarından biçimi belirler. */
export function sniffFormat(buf: Uint8Array): SniffedFormat | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length >= 8 && png.every((b, i) => buf[i] === b)) return "png";
  const ascii = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to));
  if (buf.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  return null;
}

export type ProcessedVariant = {
  width: PhotoWidth;
  /** Gerçek piksel genişliği (küçük görseller büyütülmez). */
  pixelWidth: number;
  pixelHeight: number;
  quality: number;
  data: Buffer;
};

export type ProcessedImage = {
  format: SniffedFormat;
  /** En büyük (2000) varyantın boyutları. */
  width: number;
  height: number;
  /** Varyantlarda kullanılan en düşük kalite. */
  quality: number;
  variants: ProcessedVariant[];
};

export type ProcessOptions = {
  maxVariantBytes?: number;
  maxInputPixels?: number;
  qualities?: readonly number[];
};

/**
 * JPEG/PNG/WebP → 400/1200/2000 px WebP. Her varyant ≤ 5 MB; aşarsa kalite basamaklarla
 * düşürülür, en düşükte de aşarsa tüm yükleme reddedilir (hiçbir varyant döndürülmez).
 */
export async function processImage(
  input: Uint8Array,
  opts: ProcessOptions = {},
): Promise<ProcessedImage> {
  const maxBytes = opts.maxVariantBytes ?? PHOTO_LIMITS.maxVariantBytes;
  const maxPixels = opts.maxInputPixels ?? PHOTO_LIMITS.maxInputPixels;
  const qualities = opts.qualities ?? PHOTO_LIMITS.qualities;

  const format = sniffFormat(input);
  if (!format) throw reject("unsupported_format");

  const open = () =>
    sharp(input, {
      limitInputPixels: maxPixels,
      failOn: "error",
      sequentialRead: true,
      animated: false,
    });

  const isPixelLimit = (err: unknown) => err instanceof Error && /pixel limit/i.test(err.message);
  let meta: Metadata;
  try {
    meta = await open().metadata();
  } catch (err) {
    throw reject(isPixelLimit(err) ? "too_many_pixels" : "corrupt");
  }
  if (meta.format !== format) throw reject("unsupported_format");
  if ((meta.pages ?? 1) > 1) throw reject("animated");
  if (!meta.width || !meta.height) throw reject("corrupt");
  if (meta.width * meta.height > maxPixels) throw reject("too_many_pixels");

  // 1) Yönü uygula, en fazla 2000 px genişliğe indir, ham pikselleri al (metadata burada düşer).
  let base: { data: Buffer; info: OutputInfo };
  try {
    base = await open()
      .rotate()
      .resize({ width: PHOTO_LIMITS.maxWidth, withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    if (isPixelLimit(err)) throw reject("too_many_pixels");
    throw reject("corrupt");
  }
  const { width: bw, height: bh, channels } = base.info;
  if (bw > PHOTO_LIMITS.maxWidth || bh > PHOTO_LIMITS.maxDimension) throw reject("dimensions");

  // 2) Varyantlar: büyükten küçüğe; her biri için kalite basamakları.
  const variants: ProcessedVariant[] = [];
  for (const target of [...PHOTO_LIMITS.widths].sort((a, b) => b - a)) {
    const tw = Math.min(target, bw);
    let done: ProcessedVariant | null = null;
    for (const quality of qualities) {
      const { data, info } = await sharp(base.data, {
        raw: { width: bw, height: bh, channels },
      })
        .resize({ width: tw, withoutEnlargement: true })
        .webp({ quality, effort: 4, smartSubsample: true })
        .toBuffer({ resolveWithObject: true });
      if (data.length <= maxBytes) {
        done = { width: target, pixelWidth: info.width, pixelHeight: info.height, quality, data };
        break;
      }
    }
    if (!done) throw reject("output_too_large");
    variants.push(done);
  }

  const largest = variants.find((v) => v.width === PHOTO_LIMITS.maxWidth)!;
  return {
    format,
    width: largest.pixelWidth,
    height: largest.pixelHeight,
    quality: Math.min(...variants.map((v) => v.quality)),
    variants: variants.sort((a, b) => a.width - b.width),
  };
}
