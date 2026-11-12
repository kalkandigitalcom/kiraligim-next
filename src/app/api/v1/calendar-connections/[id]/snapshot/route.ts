import { getDb } from "@/db/client";
import { snapshotEndpoint } from "@/server/api/endpoints";
import { handleApiRequest, methodNotAllowed } from "@/server/api/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET /api/v1/calendar-connections/{id}/snapshot — ilk/yeniden senkronizasyon: dolu aralıklar + cursor. */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(request, getDb(), "calendar_snapshot", (ctx) =>
    snapshotEndpoint(ctx, id),
  );
}

export {
  methodNotAllowed as DELETE,
  methodNotAllowed as PATCH,
  methodNotAllowed as POST,
  methodNotAllowed as PUT,
};
