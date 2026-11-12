import { errorResponse } from "@/server/api/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Tanımsız /api/v1 yolları: JSON 404 (HTML hata sayfası dönmez). */
const notFound = async () => errorResponse("not_found");

export {
  notFound as DELETE,
  notFound as GET,
  notFound as PATCH,
  notFound as POST,
  notFound as PUT,
};
