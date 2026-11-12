import { getDb } from "@/db/client";
import { availabilityEndpoint } from "@/server/api/endpoints";
import { handleApiRequest, methodNotAllowed } from "@/server/api/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET /api/v1/properties/{id}/availability?from=&to= — dolu aralıklar [start_date, end_date). */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(request, getDb(), "availability", (ctx) => availabilityEndpoint(ctx, id));
}

export {
  methodNotAllowed as DELETE,
  methodNotAllowed as PATCH,
  methodNotAllowed as POST,
  methodNotAllowed as PUT,
};
