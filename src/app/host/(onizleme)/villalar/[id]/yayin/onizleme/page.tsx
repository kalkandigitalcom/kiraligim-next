import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { VillaView } from "@/components/villa/villa-view";
import { getEnv } from "@/lib/env";
import { PUBLISH_REQUIREMENT_LABELS, publicVillaUrl } from "@/lib/public-profile-meta";
import { getVillaPreview } from "@/server/public/preview";
import { getStorage } from "@/server/storage";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

export const metadata: Metadata = {
  title: "Villa sayfası önizlemesi",
  robots: { index: false, follow: false },
};

type Props = { params: Promise<{ id: string }> };

/**
 * Villa sayfası önizlemesi (F2d), panel alan adında: /villalar/{id}/yayin/onizleme.
 *
 * Güvenlik:
 *  - Oturum zorunlu (withPanelTenant → requireUser; yoksa /giris).
 *  - Mülk yalnız kullanıcının aktif işletmesinde, RLS ile okunur; başka işletmenin kimliği 404.
 *  - Yalnız owner/manager (sunucuda getVillaPreview denetler); staff 404 alır.
 *  - URL'de token veya gizli bilgi yoktur; mülk kimliğini bilmek tek başına erişim sağlamaz.
 *  - Okuma salt okunur transaction'dadır; sayfa hiçbir şey yazmaz. Panel alan adı proxy'de
 *    "noindex" ve "no-store" alır; public alan adında bu yol yoktur.
 * Görünüm public sayfanın AYNI bileşenidir (VillaView); üstte yalnız önizleme bilgisi vardır.
 */
export default async function VillaPreviewPage({ params }: Props) {
  const { id } = await params;
  const storage = getStorage();
  const res = await withPanelTenant((tx, ctx) => getVillaPreview(tx, ctx, id, storage));
  if (res.kind !== "ok") notFound();

  const pageUrl = res.publicSlug ? publicVillaUrl(getEnv().PUBLIC_URL, res.publicSlug) : null;
  const vis = res.visibility;
  const unmet = vis.state === "published" ? [] : vis.unmet;

  return (
    <div className="flex flex-1 flex-col bg-white text-navy-900">
      <div
        className="border-b border-amber-300 bg-amber-50 text-amber-950"
        role="region"
        aria-label="Önizleme bilgisi"
        data-testid="preview-banner"
        data-state={vis.state}
      >
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="font-semibold">
              Önizleme ·{" "}
              {vis.state === "published"
                ? "Sayfa yayında; müşteriler bu sayfayı görüyor."
                : vis.state === "closed"
                  ? "Sayfa yayında görünüyor ama bir koşul eksik olduğu için müşterilere kapalı."
                  : "Taslak; müşteriler bu sayfayı göremez."}
            </p>
            <Link
              href={`/villalar/${id}/yayin`}
              className="rounded-lg px-2 py-1 text-sm font-semibold text-navy-900 underline underline-offset-2 hover:bg-amber-100 focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
            >
              ← Yayın ayarlarına dön
            </Link>
          </div>
          {unmet.length > 0 ? (
            <p className="text-sm" data-testid="preview-unmet">
              Yayın için eksik: {unmet.map((r) => PUBLISH_REQUIREMENT_LABELS[r]).join(", ")}.
            </p>
          ) : null}
          <p className="text-sm">
            Bu önizleme yalnız işletme sahibi ve yöneticilere açıktır; müşteriler yalnız yayındaki
            sayfayı görebilir. Takvim ve fiyat hesabı müşterinin göreceği gibi çalışır, hiçbir şey
            kaydedilmez.
            {pageUrl && vis.state === "published" ? (
              <>
                {" "}
                Müşteri bağlantısı:{" "}
                <a href={pageUrl} target="_blank" rel="noopener noreferrer" className="underline">
                  {pageUrl}
                </a>
              </>
            ) : null}
          </p>
        </div>
      </div>
      <main id="icerik" className="flex flex-1 flex-col">
        <VillaView
          v={res.villa}
          pageUrl={pageUrl}
          whatsapp={res.hasWhatsapp ? res.villa.whatsapp : null}
          preview
        />
      </main>
    </div>
  );
}
