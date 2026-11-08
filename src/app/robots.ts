import type { MetadataRoute } from "next";
import { headers } from "next/headers";

import { INDEXING_ENABLED, robotsPolicy } from "@/config/marketing";
import { getEnv } from "@/lib/env";
import { hostMapFromUrls, resolveSurface } from "@/lib/hosts";

/**
 * robots.txt. Dosya uzantılı yollar proxy'de yeniden yazılmadığı için tüm alan adları buraya gelir;
 * karar host başlığına göre verilir. Yayın koşulları hazır olana kadar her alan adında kapalı
 * (src/config/marketing.ts → INDEXING_ENABLED).
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const env = getEnv();
  const surface = resolveSurface((await headers()).get("host"), hostMapFromUrls(env));
  return robotsPolicy({
    indexingEnabled: INDEXING_ENABLED,
    isProduction: env.APP_ENV === "production",
    isSiteHost: surface === "site",
    publicUrl: env.PUBLIC_URL,
  });
}
