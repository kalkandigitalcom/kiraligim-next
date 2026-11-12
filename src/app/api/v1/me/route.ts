import { getDb } from "@/db/client";
import { meEndpoint } from "@/server/api/endpoints";
import { handleApiRequest, methodNotAllowed } from "@/server/api/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/me — anahtarın ait olduğu acente hesabı (kimlik, ad, istek sınırı). */
export async function GET(request: Request) {
  return handleApiRequest(request, getDb(), "me", meEndpoint);
}

export {
  methodNotAllowed as DELETE,
  methodNotAllowed as PATCH,
  methodNotAllowed as POST,
  methodNotAllowed as PUT,
};
