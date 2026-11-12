import { getDb } from "@/db/client";
import { accountChangesEndpoint } from "@/server/api/endpoints";
import { handleApiRequest, methodNotAllowed } from "@/server/api/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/calendar-changes?cursor=&limit= — hesap geneli değişiklik akışı. */
export async function GET(request: Request) {
  return handleApiRequest(request, getDb(), "account_changes", accountChangesEndpoint);
}

export {
  methodNotAllowed as DELETE,
  methodNotAllowed as PATCH,
  methodNotAllowed as POST,
  methodNotAllowed as PUT,
};
