import { getDb } from "@/db/client";
import { webhookRotateEndpoint } from "@/server/api/endpoints";
import { handleApiRequest, methodNotAllowedFor } from "@/server/api/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/v1/webhook/rotate-secret — yeni imza sırrı (yalnız bu yanıtta gösterilir). */
export async function POST(request: Request) {
  return handleApiRequest(request, getDb(), "webhook_rotate", webhookRotateEndpoint);
}

const notAllowed = methodNotAllowedFor("POST");
export { notAllowed as DELETE, notAllowed as GET, notAllowed as PATCH, notAllowed as PUT };
