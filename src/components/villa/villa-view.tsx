import type { PublicVilla } from "@/lib/public-villa";
import { coverFirst, locationLabel, propertyTypeLabel } from "@/lib/public-villa-view";

import { AvailabilityCalendar } from "./availability-calendar";
import { Gallery } from "./gallery";
import { MapEmbed } from "./map-embed";
import {
  Amenities,
  Description,
  Distances,
  hasPools,
  hasTerms,
  KeyFacts,
  Pools,
  PriceIncludes,
  RatesTable,
  Section,
  Terms,
  Video,
} from "./sections";
import { type StayData, StayProvider } from "./stay-context";
import { BookingCard } from "./booking-card";
import { MobileStayBar, StayQuote } from "./stay-summary";

/**
 * Villa sayfasının gövdesi. Public sayfa (/villa/{slug}) ve panel önizlemesi (F2d) AYNI bileşeni
 * kullanır; yalnız veri kaynağı farklıdır (public: F2a fonksiyonları, önizleme: tenant RLS).
 * `pageUrl` null ise (adres henüz kaydedilmemiş) WhatsApp mesajına adres eklenmez; `whatsapp`
 * null ise (önizlemede numara tanımlı değil) WhatsApp bağlantıları devre dışı gösterilir.
 */
export function VillaView({
  v,
  pageUrl,
  whatsapp,
  preview = false,
}: {
  v: PublicVilla;
  pageUrl: string | null;
  whatsapp: string | null;
  /** Panel önizlemesi: eksik içerik için ev sahibine yönelik açıklama gösterilir. */
  preview?: boolean;
}) {
  const photos = coverFirst(v.photos).map(({ src, srcSet, large, width, height }) => ({
    src,
    srcSet,
    large,
    width,
    height,
  }));
  // Tarayıcıya giden konaklama verisi: yalnız public alanlar (birleşik dolu aralıklar, fiyat
  // dönemleri, pencere). Misafir/rezervasyon bilgisi yoktur.
  const stay: StayData = {
    villaName: v.name,
    pageUrl,
    whatsapp,
    maxGuests: v.maxGuests,
    slug: pageUrl ? v.slug : null,
    // Panel önizlemesinde talep gönderilemez (yalnız görünüm).
    requestEnabled: !preview && pageUrl !== null,
    busy: v.busy,
    window: v.window,
    rates: v.rates,
    currency: v.currency,
  };

  return (
    <article
      className="mx-auto w-full max-w-6xl px-4 pt-6 pb-16 sm:px-6 sm:pt-8"
      data-testid="villa-page"
    >
      <header className="mb-5 flex flex-col gap-1.5 sm:mb-6">
        <p className="text-sm font-semibold text-turquoise-700">
          {propertyTypeLabel(v.propertyType)} · {locationLabel(v.location)}
        </p>
        <h1 className="text-3xl font-extrabold tracking-tight text-balance sm:text-4xl">
          {v.name}
        </h1>
      </header>

      {/* Yayın koşulu ≥1 fotoğraf ister; public sayfada liste yalnız depolama yapılandırılmamışsa
          boş kalır ve galeri hiç gösterilmez (F2b). Önizlemede ev sahibine açıklama gösterilir. */}
      {photos.length > 0 ? (
        <Gallery photos={photos} name={v.name} />
      ) : preview ? (
        <p
          className="rounded-3xl border border-dashed border-border bg-mist px-5 py-10 text-center text-[15px] text-navy-900/65"
          data-testid="villa-no-photos"
        >
          Henüz fotoğraf yok. Yayınlamak için en az bir fotoğraf ekleyin; galeri burada görünür.
        </p>
      ) : null}

      <StayProvider data={stay}>
        {/* Rezervasyon kartı sayfada TEK öğedir: mobilde öne çıkan bilgilerin hemen altında,
            masaüstünde sağ sütunda (ızgara yerleşimi; aynı form iki kez oluşturulmaz). */}
        <div className="mt-8 grid gap-x-14 gap-y-6 lg:mt-10 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="min-w-0 lg:col-start-1 lg:row-start-1">
            <KeyFacts v={v} />
          </div>
          <aside
            className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1"
            aria-label="Rezervasyon"
          >
            <BookingCard className="lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto lg:overscroll-contain" />
          </aside>
          <div className="min-w-0 lg:col-start-1 lg:row-start-2">
            <div className="mt-3 lg:mt-3">
              {v.descriptionHtml && (
                <Section id="aciklama" title="Villa hakkında">
                  <Description html={v.descriptionHtml} />
                </Section>
              )}
              <Section id="musaitlik" title="Müsaitlik ve fiyat hesaplama">
                <div className="flex flex-col gap-6">
                  <AvailabilityCalendar />
                  <StayQuote />
                </div>
              </Section>
              {v.amenities.length > 0 && (
                <Section id="olanaklar" title="Olanaklar">
                  <Amenities keys={v.amenities} />
                </Section>
              )}
              {hasPools(v.pools) && (
                <Section id="havuz" title="Havuz">
                  <Pools pools={v.pools} />
                </Section>
              )}
              {(v.map || v.distances.length > 0) && (
                <Section id="konum" title="Konum ve yakın yerler">
                  <div className="flex flex-col gap-6">
                    {v.map && <MapEmbed map={v.map} name={v.name} />}
                    {v.distances.length > 0 && <Distances items={v.distances} />}
                  </div>
                </Section>
              )}
              <Section id="fiyatlar" title="Sezon fiyatları">
                <RatesTable rates={v.rates} today={v.window.today} />
              </Section>
              {v.priceIncludes.length > 0 && (
                <Section id="fiyata-dahil" title="Fiyata dahil olanlar">
                  <PriceIncludes keys={v.priceIncludes} />
                </Section>
              )}
              {hasTerms(v) && (
                <Section id="kosullar" title="Konaklama bilgileri">
                  <Terms v={v} />
                </Section>
              )}
              {v.youtubeVideoId && (
                <Section id="video" title="Video">
                  <Video id={v.youtubeVideoId} name={v.name} />
                </Section>
              )}
            </div>
          </div>
        </div>
        <MobileStayBar />
      </StayProvider>
    </article>
  );
}
