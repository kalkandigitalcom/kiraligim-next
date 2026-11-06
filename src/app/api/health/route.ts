import { NextResponse } from "next/server";

import { checkHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — Coolify sağlık kontrolü ve deploy sonrası duman testi.
 * Veri yazmaz. Hata ayrıntısı döndürmez (yalnız log'a yazılır).
 */
export async function GET() {
  const report = await checkHealth();
  return NextResponse.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
