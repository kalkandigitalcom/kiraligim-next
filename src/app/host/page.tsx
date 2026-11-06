import type { Metadata } from "next";

import { SurfacePlaceholder } from "@/components/layout/surface-placeholder";
import { getBrand } from "@/config/brand";

export const metadata: Metadata = { title: "Ev sahibi paneli" };

export default function HostHomePage() {
  return (
    <SurfacePlaceholder
      brandName={getBrand().name}
      title="Ev sahibi paneli"
      description="Rezervasyon, takvim, misafir ve mülk yönetimi burada olacak. Giriş sistemi Faz 2'de eklenecek."
    />
  );
}
