"use client";

import { useState } from "react";

import { LazyLeafletMap } from "@/components/map/lazy-leaflet-map";
import { useHydrated } from "@/components/ui/use-hydrated";
import type { PublicMap } from "@/lib/public-villa";

type Props = {
  /** Sunucuda hazırlanmış harita (Google adresi yeniden doğrulanmış; iğne aralıkta). */
  map: PublicMap;
  name: string;
};

const FRAME = "aspect-[4/3] w-full rounded-2xl border border-border bg-mist sm:aspect-[16/9]";

/**
 * Villa konumu: sahibin seçtiği yöntem.
 *  - Google Haritalar: ham iframe kodu yoktur; `src` yalnız doğrulanmış iki kalıptan biridir;
 *    iframe sandbox ile üst sayfayı yönlendiremez, form gönderemez. CSP: frame-src www.google.com.
 *  - İğne: OpenStreetMap (Leaflet), yalnız tıklanınca yüklenen ayrı paket. CSP: img-src
 *    tile.openstreetmap.org.
 * İki yöntemde de misafir "Haritayı göster"e basmadan üçüncü tarafa hiçbir istek gitmez (KVKK /
 * üçüncü taraf çerezleri; YouTube kararıyla aynı yaklaşım).
 */
export function MapEmbed({ map, name }: Props) {
  const hydrated = useHydrated();
  const [shown, setShown] = useState(false);
  const openUrl = map.openUrl;
  const notice =
    map.kind === "google"
      ? "Harita Google Haritalar'dan yüklenir."
      : "Harita OpenStreetMap'ten yüklenir.";
  return (
    <div className="flex flex-col gap-3" data-testid="villa-map" data-kind={map.kind}>
      {shown && map.kind === "pin" ? (
        <div className={`${FRAME} relative isolate overflow-hidden`}>
          <LazyLeafletMap
            pin={{ lat: map.lat, lng: map.lng }}
            label={`${name} konumu (OpenStreetMap haritası)`}
            className="size-full"
          />
        </div>
      ) : shown && map.kind === "google" ? (
        <iframe
          src={map.embedUrl}
          title={`${name} konumu (Google Haritalar)`}
          className={FRAME}
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          data-testid="villa-map-frame"
        />
      ) : (
        <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-mist/70 px-6 text-center sm:aspect-[16/9]">
          <MapPinIcon />
          <p className="max-w-sm text-[15px] text-navy-900/70">{notice}</p>
          <button
            type="button"
            onClick={() => setShown(true)}
            disabled={!hydrated}
            className="inline-flex h-11 items-center justify-center rounded-xl bg-navy-900 px-5 text-[15px] font-semibold text-white hover:bg-navy-800 focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none disabled:opacity-60"
            data-testid="villa-map-show"
          >
            Haritayı göster
          </button>
        </div>
      )}
      {openUrl ? (
        <a
          href={openUrl}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="self-start text-[15px] font-semibold text-turquoise-700 underline-offset-2 hover:underline"
          data-testid="villa-map-open"
        >
          Google Haritalar&apos;da aç<span className="sr-only"> (yeni sekmede açılır)</span>
        </a>
      ) : null}
    </div>
  );
}

const MapPinIcon = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className="size-8 fill-none stroke-turquoise-700 stroke-[1.8]"
  >
    <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0113 0c0 5.4-6.5 11-6.5 11z" strokeLinejoin="round" />
    <circle cx="12" cy="10" r="2.5" />
  </svg>
);
