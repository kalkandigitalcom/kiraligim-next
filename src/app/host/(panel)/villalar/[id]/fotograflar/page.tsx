import { redirect } from "next/navigation";

import { stepHref } from "@/lib/property-wizard";

type Props = { params: Promise<{ id: string }> };

/**
 * Eski "Fotoğraflar" sekmesi (Aşama 3'te kaldırıldı): fotoğraflar sihirbazın 2. adımındadır.
 * Kayıtlı bağlantılar çalışmaya devam etsin diye yönlendirilir; erişim denetimi hedef sayfadadır
 * (başka işletmenin mülkü veya geçersiz kimlik → 404).
 */
export default async function PropertyPhotosRedirect({ params }: Props) {
  const { id } = await params;
  redirect(stepHref(encodeURIComponent(id), "aciklama"));
}
