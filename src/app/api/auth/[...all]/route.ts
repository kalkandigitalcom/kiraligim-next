import { getEnv } from "@/lib/env";
import { getHostAuth } from "@/server/auth/host-auth";
import { createAuthRouteHandler } from "@/server/auth/route-handler";
import { getAuthStatus } from "@/server/auth/status";

/** Ev sahibi kimlik uç noktası (Better Auth). Yalnız app.<alan-adı>; bkz. route-handler.ts. */
export const dynamic = "force-dynamic";

let handler: ((request: Request) => Promise<Response>) | undefined;

function getHandler() {
  handler ??= createAuthRouteHandler({
    appUrl: getEnv().APP_URL,
    isAvailable: () => getAuthStatus().available,
    handle: (request) => getHostAuth().handler(request),
  });
  return handler;
}

export const GET = (request: Request) => getHandler()(request);
export const POST = (request: Request) => getHandler()(request);
