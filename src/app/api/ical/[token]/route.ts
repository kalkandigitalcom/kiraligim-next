import { getDb } from "@/db/client";
import { logger } from "@/lib/logger";
import { buildExportFeed } from "@/server/ical/export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NOT_FOUND = () =>
  new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });

/**
 * GET /api/ical/<belirteç>.ics — mülkün dışa aktarma akışı (Airbnb, Booking.com vb. bu adresi
 * kendi aralıklarında çeker). Oturum yoktur; erişim yalnız tahmin edilemez belirteçle (32 bayt).
 * Geçersiz/eski belirteç ile pasif işletmede 404 (varlık sızmaz). Belirteç log'a yazılmaz.
 * Akış yalnız Kiraligim kayıtlarını içerir; içe aktarılan harici olaylar hiçbir zaman dönmez.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  const token = raw.endsWith(".ics") ? raw.slice(0, -4) : raw;
  try {
    const feed = await buildExportFeed(getDb(), token);
    if (!feed.ok) return NOT_FOUND();
    return new Response(feed.ics, {
      status: 200,
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": 'inline; filename="kiraligim.ics"',
        "cache-control": "no-store",
        "x-robots-tag": "noindex",
      },
    });
  } catch (err) {
    logger.error("ical_export_failed", { err });
    return new Response("Service unavailable", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
}
