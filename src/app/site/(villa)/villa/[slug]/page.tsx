import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { getBrand } from "@/config/brand";
import { INDEXING_ENABLED } from "@/config/marketing";
import { getDb } from "@/db/client";
import { publicVillaUrl } from "@/lib/public-profile-meta";
import { coverFirst, metaDescription } from "@/lib/public-villa-view";
import { getPublicVilla } from "@/server/public/villa";
import { getStorage } from "@/server/storage";

import { VillaView } from "@/components/villa/villa-view";

/**
 * Müşteriye açık villa sayfası (F2b): /villa/{slug} (kök alan adı). Yalnız görüntüleme: veri F2a
 * servisinden (salt okunur, sabit kolonlu public fonksiyonlar) gelir; yazma işlemi ve talep formu
 * yoktur (F3). F2c: müsaitlik takvimi ve fiyat hesaplayıcı tarayıcıda, mevcut quoteStay ile çalışır;
 * seçim hiçbir yere kaydedilmez.
 */

type Props = { params: Promise<{ slug: string }> };

// generateMetadata ve sayfa aynı istekte tek okuma yapar.
const loadVilla = cache((slug: string) => getPublicVilla(getDb(), getStorage(), slug));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const v = await loadVilla(slug);
  // İndeksleme yayın koşulları hazır olana kadar kapalı (src/config/marketing.ts); bulunamayan
  // sayfa her durumda noindex.
  const robots =
    v && INDEXING_ENABLED ? { index: true, follow: true } : { index: false, follow: false };
  if (!v) return { title: "Sayfa bulunamadı", robots };
  const brand = getBrand();
  const description = metaDescription(v);
  const cover = coverFirst(v.photos)[0];
  const title = `${v.name} · ${v.location.district}`;
  return {
    metadataBase: new URL(brand.publicUrl),
    title,
    description,
    alternates: { canonical: `/villa/${v.slug}` },
    openGraph: {
      type: "website",
      locale: "tr_TR",
      siteName: brand.name,
      title,
      description,
      url: `/villa/${v.slug}`,
      images: cover
        ? [
            {
              url: cover.src,
              width: 1200,
              height: Math.round((1200 * cover.height) / cover.width),
              alt: v.name,
            },
          ]
        : [],
    },
    robots,
  };
}

export default async function VillaPage({ params }: Props) {
  const { slug } = await params;
  const v = await loadVilla(slug);
  if (!v) notFound();

  const pageUrl = publicVillaUrl(getBrand().publicUrl, v.slug);
  return <VillaView v={v} pageUrl={pageUrl} whatsapp={v.whatsapp} />;
}
