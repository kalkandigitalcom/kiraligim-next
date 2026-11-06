import { SurfacePlaceholder } from "@/components/layout/surface-placeholder";
import { getBrand } from "@/config/brand";

export default function SiteHomePage() {
  const brand = getBrand();
  return (
    <SurfacePlaceholder
      brandName={brand.name}
      title="Konaklama yönetim platformu"
      description="Takvim, misafir kaydı, bildirim takibi ve dijital misafir rehberi tek yerde. Yakında."
    />
  );
}
