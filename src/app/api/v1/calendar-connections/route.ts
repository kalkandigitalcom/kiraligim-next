import { getDb } from "@/db/client";
import { connectEndpoint, connectionsEndpoint } from "@/server/api/endpoints";
import { handleApiRequest, methodNotAllowedFor } from "@/server/api/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/calendar-connections — acentenin takvim bağlantıları. */
export async function GET(request: Request) {
  return handleApiRequest(request, getDb(), "calendar_connections", connectionsEndpoint);
}

/** POST /api/v1/calendar-connections — villa bağlantısı (etkin izin varsa doğrudan active). */
export async function POST(request: Request) {
  return handleApiRequest(request, getDb(), "calendar_connect", connectEndpoint);
}

const notAllowed = methodNotAllowedFor("GET, POST");
export { notAllowed as DELETE, notAllowed as PATCH, notAllowed as PUT };
