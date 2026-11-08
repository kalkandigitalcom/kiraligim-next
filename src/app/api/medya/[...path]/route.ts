import { getEnv } from "@/lib/env";
import { createLocalMediaHandler } from "@/server/storage/local-media";

/**
 * YALNIZ YEREL GELİŞTİRME: filesystem sürücüsündeki fotoğrafları sunar. production'da, R2
 * kullanılırken veya panel ve kök (villa sayfası) alan adları dışında 404 döner
 * (src/server/storage/local-media.ts).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const env = getEnv();
  return createLocalMediaHandler({
    appUrl: env.APP_URL,
    publicUrl: env.PUBLIC_URL,
    appEnv: env.APP_ENV,
  })(request, path);
}
