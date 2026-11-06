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
