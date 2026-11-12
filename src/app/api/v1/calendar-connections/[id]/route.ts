import { getDb } from "@/db/client";
import { connectionEndpoint, disconnectEndpoint } from "@/server/api/endpoints";
import { handleApiRequest, methodNotAllowedFor } from "@/server/api/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET /api/v1/calendar-connections/{id} — tek bağlantı (yalnız kendi bağlantısı). */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(request, getDb(), "calendar_connection", (ctx) =>
    connectionEndpoint(ctx, id),
  );
}

/** DELETE /api/v1/calendar-connections/{id} — bağlantıyı keser (idempotent). */
export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(request, getDb(), "calendar_disconnect", (ctx) =>
    disconnectEndpoint(ctx, id),
  );
}

const notAllowed = methodNotAllowedFor("GET, DELETE");
export { notAllowed as PATCH, notAllowed as POST, notAllowed as PUT };
