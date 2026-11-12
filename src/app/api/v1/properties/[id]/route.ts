import { getDb } from "@/db/client";
import { propertyEndpoint } from "@/server/api/endpoints";
import { handleApiRequest, methodNotAllowed } from "@/server/api/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET /api/v1/properties/{id} — izinli tek villa (kimlik, ad); değilse 404. */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(request, getDb(), "property", (ctx) => propertyEndpoint(ctx, id));
}

export {
  methodNotAllowed as DELETE,
  methodNotAllowed as PATCH,
  methodNotAllowed as POST,
  methodNotAllowed as PUT,
};
