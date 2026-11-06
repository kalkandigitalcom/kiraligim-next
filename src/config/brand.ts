import "server-only";

import { getEnv } from "@/lib/env";

/**
 * Marka bilgisi koda gömülmez; APP_NAME ortam değişkeninden gelir.
 * Logo ve ikon dosyaları src/app/icon.svg ve public/brand altında değiştirilebilir.
 */
export function getBrand() {
  const env = getEnv();
  return { name: env.APP_NAME, publicUrl: env.PUBLIC_URL } as const;
}
