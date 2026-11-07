import "server-only";

/**
 * /api/auth/* uç noktası. proxy.ts /api/* isteklerini host'a göre yeniden yazmadığı için bu route
 * her host'tan erişilebilir olurdu; burada YALNIZ app.<alan-adı> kabul edilir. Admin ve public
 * alan adlarında 404 döner (ev sahibi oturumu yalnız panel alan adında yaşar).
 * Kimlik ortam değişkenleri eksikse 503 döner (sahte başarı yok).
 * Deneme sınırı, köken (CSRF) denetimi ve çerezler Better Auth'ta, yapılandırıldığı gibi kalır.
 */
export type AuthRouteDeps = {
  appUrl: string;
  isAvailable: () => boolean;
  handle: (request: Request) => Promise<Response>;
};

const json = (status: number, body: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });

export function createAuthRouteHandler(deps: AuthRouteDeps) {
  const appHost = new URL(deps.appUrl).host.toLowerCase();
  return async (request: Request): Promise<Response> => {
    const host = request.headers.get("host")?.trim().toLowerCase();
    if (host !== appHost) return json(404, { code: "NOT_FOUND" });
    if (!deps.isAvailable()) {
      return json(503, {
        code: "AUTH_UNAVAILABLE",
        message: "Giriş sistemi geçici olarak kullanılamıyor.",
      });
    }
    return deps.handle(request);
  };
}
