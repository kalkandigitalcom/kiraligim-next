/**
 * Gerçek Kiralığım panelinden alınmış ekran görüntüleri (public/marketing). Kurgusal demo verisiyle,
 * yerel test ortamında üretildi; gerçek müşteri bilgisi içermez. Boyutlar CLS olmaması içindir.
 */
export const SHOTS = {
  takvimYakin: { name: "panel-takvim-yakin", w: 1400, h: 1104, widths: [840, 1400] },
  rezervasyonlar: { name: "panel-rezervasyonlar", w: 1600, h: 1000, widths: [960, 1600] },
  donemler: { name: "panel-donemler", w: 1200, h: 1477, widths: [720, 1200] },
  teklif: { name: "panel-teklif", w: 1200, h: 582, widths: [720, 1200] },
  mobilTakvim: { name: "mobil-takvim", w: 585, h: 1200, widths: [585] },
  mobilTeklif: { name: "mobil-teklif", w: 585, h: 1266, widths: [585] },
} as const;

export type Shot = (typeof SHOTS)[keyof typeof SHOTS];

/** Kurgusal mülk fotoğrafları (illüstrasyon). */
export const DEMO_PHOTOS = [
  { name: "demo-havuz", alt: "Havuz ve deniz manzarası (örnek görsel)" },
  { name: "demo-teras", alt: "Deniz manzaralı teras (örnek görsel)" },
  { name: "demo-salon", alt: "Salon (örnek görsel)" },
  { name: "demo-yatak", alt: "Yatak odası (örnek görsel)" },
  { name: "demo-mutfak", alt: "Mutfak (örnek görsel)" },
  { name: "demo-bahce", alt: "Bahçe (örnek görsel)" },
] as const;
