import type { Metadata } from "next";

import { SurfacePlaceholder } from "@/components/layout/surface-placeholder";
import { getBrand } from "@/config/brand";

export const metadata: Metadata = { title: "Yönetim" };

export default function AdminHomePage() {
  return (
    <SurfacePlaceholder
      brandName={getBrand().name}
      title="Platform yönetimi"
      description="Super Admin paneli. Erişim, 2FA zorunlu ayrı bir giriş akışıyla korunacak."
    />
  );
}
