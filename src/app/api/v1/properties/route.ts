import { getDb } from "@/db/client";
import { propertiesEndpoint } from "@/server/api/endpoints";
import { handleApiRequest, methodNotAllowed } from "@/server/api/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/properties — erişim izni verilmiş villalar (yalnız kimlik ve ad). */
export async function GET(request: Request) {
  return handleApiRequest(request, getDb(), "properties", propertiesEndpoint);
}

export {
  methodNotAllowed as DELETE,
  methodNotAllowed as PATCH,
  methodNotAllowed as POST,
  methodNotAllowed as PUT,
};
