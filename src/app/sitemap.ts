import type { MetadataRoute } from "next";
import { headers } from "next/headers";

import { INDEXING_ENABLED, sitemapUrls } from "@/config/marketing";
import { getEnv } from "@/lib/env";
import { hostMapFromUrls, resolveSurface } from "@/lib/hosts";

/** sitemap.xml: yalnız indeksleme açıkken ve kök alan adında dolu; aksi hâlde boş liste. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Önce istek başlığı: rota istek anında üretilir; build sırasında getEnv() çalışmaz.
  const host = (await headers()).get("host");
  const env = getEnv();
  const surface = resolveSurface(host, hostMapFromUrls(env));
  return sitemapUrls({
    indexingEnabled: INDEXING_ENABLED,
    isProduction: env.APP_ENV === "production",
    isSiteHost: surface === "site",
    publicUrl: env.PUBLIC_URL,
  }).map((url) => ({ url, changeFrequency: "weekly" }));
}
