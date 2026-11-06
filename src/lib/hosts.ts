/**
 * Alan adına göre yüzey (surface) seçimi:
 *   app.<alan>   → ev sahibi paneli   (src/app/host)
 *   admin.<alan> → Super Admin paneli (src/app/admin)
 *   <alan>       → public sayfalar    (src/app/site)
 */

export type Surface = "host" | "admin" | "site";

export const SURFACES: readonly Surface[] = ["host", "admin", "site"];

export type HostMap = Record<Surface, string>;

export function hostMapFromUrls(urls: {
  APP_URL: string;
  ADMIN_URL: string;
  PUBLIC_URL: string;
}): HostMap {
  return {
    host: new URL(urls.APP_URL).host.toLowerCase(),
    admin: new URL(urls.ADMIN_URL).host.toLowerCase(),
    site: new URL(urls.PUBLIC_URL).host.toLowerCase(),
  };
}

export function resolveSurface(hostHeader: string | null, map: HostMap): Surface | null {
  if (!hostHeader) return null;
  const host = hostHeader.trim().toLowerCase();
  for (const surface of SURFACES) {
    if (map[surface] === host) return surface;
  }
  return null;
}

/**
 * `www.<public-host>` isteklerini kalıcı olarak kök alan adına yönlendirmek için hedef origin döner.
 * Yalnız public alan adının www sürümü yönlendirilir; diğer bilinmeyen host'lar 404 alır.
 */
export function wwwRedirectOrigin(
  hostHeader: string | null,
  map: HostMap,
  publicUrl: string,
): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.trim().toLowerCase();
  if (map.site.startsWith("www.")) return null;
  if (host !== `www.${map.site}`) return null;
  return new URL(publicUrl).origin;
}
