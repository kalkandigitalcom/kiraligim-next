import { getDb } from "@/db/client";
import {
  webhookDeleteEndpoint,
  webhookGetEndpoint,
  webhookPutEndpoint,
} from "@/server/api/endpoints";
import { handleApiRequest, methodNotAllowedFor } from "@/server/api/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/webhook — hesabın webhook adresi (sır dönmez). */
export async function GET(request: Request) {
  return handleApiRequest(request, getDb(), "webhook_get", webhookGetEndpoint);
}

/** PUT /api/v1/webhook {url} — oluştur (201 + sır, bir kez) ya da adresi değiştir (200). */
export async function PUT(request: Request) {
  return handleApiRequest(request, getDb(), "webhook_put", webhookPutEndpoint);
}

/** DELETE /api/v1/webhook — webhook'u siler; bekleyen teslimler iptal edilir. */
export async function DELETE(request: Request) {
  return handleApiRequest(request, getDb(), "webhook_delete", webhookDeleteEndpoint);
}

const notAllowed = methodNotAllowedFor("GET, PUT, DELETE");
export { notAllowed as PATCH, notAllowed as POST };
