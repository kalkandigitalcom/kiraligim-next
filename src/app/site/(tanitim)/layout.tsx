import type { Metadata } from "next";

import { INDEXING_ENABLED, SITE_COPY, SITE_MAINTENANCE } from "@/config/marketing";
import { getBrand } from "@/config/brand";

import { MotionRoot } from "./_components/motion-root";
import { siteLinks } from "./_components/site-links";
import { SiteFooter } from "./_components/site-footer";
import { SiteHeader } from "./_components/site-header";

export async function generateMetadata(): Promise<Metadata> {
  const brand = getBrand();
  return {
    metadataBase: new URL(brand.publicUrl),
    description: SITE_COPY.description,
    alternates: { canonical: "/" },
    openGraph: {
      type: "website",
      locale: "tr_TR",
      siteName: brand.name,
      title: `${brand.name} · ${SITE_COPY.title}`,
      description: SITE_COPY.description,
      url: "/",
    },
    // Yayın koşulları hazır olana kadar kapalı (src/config/marketing.ts). Açıldığında da
    // production dışındaki ortamlarda proxy.ts x-robots-tag: noindex ekler.
    robots: INDEXING_ENABLED ? { index: true, follow: true } : { index: false, follow: false },
  };
}

/**
 * Tanıtım sitesi (kök alan adı). Misafir formu ve QR rehber gibi diğer public sayfalar bu grubun
 * dışında kalır; üst bar ve alt bilgi yalnız tanıtım sayfalarındadır.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  // Bakım ekranı kendi üst ve alt bilgisini taşır; tanıtım menüsü ve hareket betiği yüklenmez.
  if (SITE_MAINTENANCE) return <>{children}</>;
  const links = siteLinks();
  return (
    <div className="flex flex-1 flex-col overflow-x-clip bg-white text-navy-900">
      <a
        href="#icerik"
        className="sr-only z-50 rounded-lg bg-navy-900 px-4 py-2 text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        İçeriğe geç
      </a>
      <SiteHeader trial={links.trial} loginHref={links.login} />
      <main id="icerik" className="flex flex-1 flex-col">
        {children}
      </main>
      <SiteFooter loginHref={links.login} />
      <MotionRoot />
    </div>
  );
}
