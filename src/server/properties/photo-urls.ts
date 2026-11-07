import { PHOTO_LIMITS } from "@/lib/photo-meta";
import type { ObjectStorage } from "@/server/storage/types";

import { variantKey } from "./photos";

export type PhotoSources = {
  /** Varsayılan (1200 px) adres. */
  src: string;
  thumb: string;
  large: string;
  /** "…/400.webp 400w, …/1200.webp 1200w, …/2000.webp 2000w" */
  srcSet: string;
};

/** Depolama öneki → herkese açık varyant adresleri. Depolama yapılandırılmamışsa null. */
export function photoSources(storage: ObjectStorage | null, prefix: string): PhotoSources | null {
  if (!storage) return null;
  const url = (w: (typeof PHOTO_LIMITS.widths)[number]) => storage.publicUrl(variantKey(prefix, w));
  return {
    src: url(1200),
    thumb: url(400),
    large: url(2000),
    srcSet: PHOTO_LIMITS.widths.map((w) => `${url(w)} ${w}w`).join(", "),
  };
}
