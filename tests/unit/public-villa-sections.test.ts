import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Gallery } from "@/components/villa/gallery";
import { KeyFacts, Pools } from "@/components/villa/sections";
import type { PublicPool, PublicVilla } from "@/lib/public-villa";

/** F2b düzeltmeleri: havuz ifadeleri ve boş galeri (sunucu render çıktısı). */

const swimming = (o: Partial<PublicPool> = {}): PublicPool => ({
  depth: 1.6,
  width: 4,
  length: 9,
  protected: false,
  ...o,
});
const pools = (s: PublicPool | null): PublicVilla["pools"] => ({
  swimming: s,
  indoor: null,
  kids: null,
});
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const villa = (p: PublicVilla["pools"]) =>
  ({
    maxGuests: 8,
    bedrooms: 4,
    bathrooms: 3,
    pools: p,
  }) as PublicVilla;

describe("havuz kartı: korunaklı havuz", () => {
  it("true → 'Korunaklı havuz' gösterilir", () => {
    const out = html(createElement(Pools, { pools: pools(swimming({ protected: true })) }));
    expect(out).toContain("Korunaklı havuz");
    expect(out).toContain("Yüzme Havuzu");
  });

  it("false → korunaklı havuz ifadesi yok; eski 'çocuk koruma' ifadesi hiç yok", () => {
    const out = html(createElement(Pools, { pools: pools(swimming({ protected: false })) }));
    expect(out).toContain("Yüzme Havuzu");
    expect(out).not.toMatch(/Korunaklı/i);
    expect(out).not.toMatch(/koruma önlemi/i);
  });

  it("korunaklı bilgisi olmayan havuz (kapalı/çocuk) → ifade yok", () => {
    const out = html(
      createElement(Pools, {
        pools: { swimming: null, indoor: { depth: 1.4, width: 3, length: 6 }, kids: null },
      }),
    );
    expect(out).toContain("Kapalı Havuz");
    expect(out).not.toMatch(/Korunaklı|koruma önlemi/i);
  });
});

describe("bilgi şeridi: havuz etiketi", () => {
  it("yüzme havuzu varsa 'Yüzme havuzu'; 'Özel havuz' yok", () => {
    const out = html(createElement(KeyFacts, { v: villa(pools(swimming())) }));
    expect(out).toContain("Yüzme havuzu");
    expect(out).not.toContain("Özel havuz");
  });

  it("yüzme havuzu yoksa havuz etiketi yok", () => {
    const out = html(createElement(KeyFacts, { v: villa(pools(null)) }));
    expect(out).not.toMatch(/havuz/i);
  });
});

describe("galeri", () => {
  const photo = (n: number) => ({
    src: `/api/medya/p${n}/1200.webp`,
    srcSet: `/api/medya/p${n}/400.webp 400w, /api/medya/p${n}/1200.webp 1200w`,
    large: `/api/medya/p${n}/2000.webp`,
    width: 1800,
    height: 1200,
  });

  it("fotoğraf yoksa hiçbir şey render edilmez (boş kutu, '0 fotoğraf' yok)", () => {
    const out = html(createElement(Gallery, { photos: [], name: "Villa Defne" }));
    expect(out).toBe("");
  });

  it("fotoğraf varsa mevcut davranış: mobil şerit + masaüstü mozaik, sayı ve büyük görsel bağlantıları", () => {
    const photos = [1, 2, 3, 4, 5, 6].map(photo);
    const out = html(createElement(Gallery, { photos, name: "Villa Defne" }));
    expect(out).toContain('data-testid="villa-gallery"');
    expect(out).toContain("6 fotoğraf");
    expect(out).toContain("Tüm fotoğraflar (6)");
    // Mobil şeritte 6, masaüstü mozaikte 5 kare; her kare büyük görsele bağlantı.
    expect(out.match(/<a /g)).toHaveLength(11);
    expect(out.match(/href="\/api\/medya\/p\d\/2000\.webp"/g)).toHaveLength(11);
    expect(out).toContain('alt="Villa Defne – fotoğraf 1 / 6"');
    expect(out).toContain("<dialog");
  });

  it("tek fotoğrafta 'Tüm fotoğraflar' düğmesi yok, kare gösterilir", () => {
    const out = html(createElement(Gallery, { photos: [photo(1)], name: "V" }));
    expect(out).toContain("1 fotoğraf");
    expect(out).not.toContain("Tüm fotoğraflar");
    expect(out.match(/<img /g)).toHaveLength(2);
  });
});
