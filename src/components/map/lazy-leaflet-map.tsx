"use client";

import dynamic from "next/dynamic";

/**
 * Leaflet yalnız gerektiğinde ve yalnız istemcide yüklenir (ayrı paket; sunucu render'ı yok).
 * Kapsayıcı boyutu çağıranda verilir; yüklenirken aynı alanda bekleme metni görünür.
 */
export const LazyLeafletMap = dynamic(() => import("./leaflet-map"), {
  ssr: false,
  loading: () => (
    <div className="flex size-full items-center justify-center text-sm text-navy-900/60">
      Harita yükleniyor…
    </div>
  ),
});
