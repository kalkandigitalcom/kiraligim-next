"use client";

import "leaflet/dist/leaflet.css";

import L from "leaflet";
import { useEffect, useRef } from "react";

import {
  DEFAULT_VIEW,
  type MapPin,
  OSM_ATTRIBUTION,
  OSM_MAX_ZOOM,
  OSM_TILE_URL,
  PIN_ZOOM,
} from "@/lib/map-pin";

type Props = {
  /** Gösterilecek iğne; yoksa Türkiye görünümü. */
  pin: MapPin | null;
  /** Düzenleme: tıklayınca iğne bırakılır, iğne sürüklenebilir. */
  editable?: boolean;
  onPinChange?: (pin: MapPin) => void;
  /** Harita alanının erişilebilir adı. */
  label: string;
  className?: string;
};

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * İğne simgesi: CSS dosyası veya satır içi stil gerektirmeyen SVG (CSP style-src nonce'lu; Leaflet
 * konumları yalnız CSSOM ile — `element.style.x = …` — ayarlar, bu CSP'ye takılmaz). Leaflet'in
 * varsayılan PNG simgesi paketleyicide yol sorunu çıkardığı için kullanılmaz.
 */
const PIN_ICON = L.divIcon({
  className: "kiraligim-map-pin",
  html: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 42" width="32" height="42" aria-hidden="true"><path d="M16 41s13-12.6 13-24A13 13 0 0 0 3 17c0 11.4 13 24 13 24z" fill="#0f2a44" stroke="#ffffff" stroke-width="2"/><circle cx="16" cy="16.5" r="5" fill="#2ec4b6"/></svg>',
  iconSize: [32, 42],
  iconAnchor: [16, 41],
});

/**
 * OpenStreetMap haritası (Leaflet). Yalnız istemcide ve gerektiğinde yüklenir (next/dynamic,
 * ssr: false): misafir sayfasında "Haritayı göster"e basılınca, panelde iğne yöntemi seçilince.
 * API anahtarı yoktur; karolar tile.openstreetmap.org'dan gelir (CSP img-src).
 */
export default function LeafletMap({
  pin,
  editable = false,
  onPinChange,
  label,
  className,
}: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const onChangeRef = useRef(onPinChange);
  useEffect(() => {
    onChangeRef.current = onPinChange;
  }, [onPinChange]);
  // İlk açılış görünümü için başlangıç iğnesi (sonraki değişiklikler aşağıdaki etkide).
  const initialPin = useRef(pin);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const start = initialPin.current;
    const map = L.map(el, {
      center: start ? [start.lat, start.lng] : [DEFAULT_VIEW.lat, DEFAULT_VIEW.lng],
      zoom: start ? PIN_ZOOM : DEFAULT_VIEW.zoom,
      // Misafir sayfasında fare tekerleği sayfayı kaydırır; mobilde tek parmak sayfayı kaydırır
      // (iki parmakla yakınlaştırma açık).
      scrollWheelZoom: editable,
      dragging: editable || !L.Browser.mobile,
      maxZoom: OSM_MAX_ZOOM,
    });
    L.tileLayer(OSM_TILE_URL, {
      maxZoom: OSM_MAX_ZOOM,
      attribution: OSM_ATTRIBUTION,
      // OSM karo sunucusu Referer bekler; sayfanın politikasıyla aynı.
      referrerPolicy: "strict-origin-when-cross-origin",
    }).addTo(map);
    map.attributionControl.setPrefix(false);
    mapRef.current = map;
    el.dataset.ready = "true";

    if (editable) {
      map.on("click", (e: L.LeafletMouseEvent) => {
        const p = { lat: round6(e.latlng.lat), lng: round6(e.latlng.lng) };
        onChangeRef.current?.(p);
      });
    }

    // Kapsayıcı boyutu değişince (mobil döndürme, panel açılması) karoları yeniden hesapla.
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      delete el.dataset.ready;
    };
  }, [editable]);

  // İğne değişince işaretçiyi oluştur / taşı / kaldır.
  const lat = pin?.lat ?? null;
  const lng = pin?.lng ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const el = elRef.current;
    if (lat === null || lng === null) {
      markerRef.current?.remove();
      markerRef.current = null;
      if (el) el.dataset.pin = "";
      return;
    }
    const ll = L.latLng(lat, lng);
    if (markerRef.current) {
      markerRef.current.setLatLng(ll);
    } else {
      const m = L.marker(ll, {
        icon: PIN_ICON,
        draggable: editable,
        keyboard: false,
        title: "Villa konumu",
        alt: "Villa konumu",
      }).addTo(map);
      if (editable) {
        m.on("dragend", () => {
          const p = m.getLatLng();
          onChangeRef.current?.({ lat: round6(p.lat), lng: round6(p.lng) });
        });
      }
      markerRef.current = m;
    }
    if (!map.getBounds().contains(ll)) map.setView(ll, Math.max(map.getZoom(), PIN_ZOOM - 3));
    if (el) el.dataset.pin = `${lat},${lng}`;
  }, [lat, lng, editable]);

  return (
    <div
      ref={elRef}
      role="region"
      aria-label={label}
      className={className}
      data-testid={editable ? "map-pin-editor" : "villa-map-leaflet"}
    />
  );
}
