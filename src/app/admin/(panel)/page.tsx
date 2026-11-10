import type { Metadata } from "next";

import { requireAdmin } from "@/server/admin/session";

export const metadata: Metadata = { title: "Platform yönetimi" };

export default async function AdminHomePage() {
  const admin = await requireAdmin();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-navy-900">
          Hoş geldiniz, {admin.name}
        </h1>
        <p className="mt-1 text-[15px] text-muted-foreground">
          Kiralığım platform yönetimi. Buradaki işlemler denetim kaydına yazılır.
        </p>
      </div>
      <section className="rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6">
        <h2 className="font-semibold text-navy-900">WhatsApp grup yönetimi</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Keşfedilen grupların işletme ve villayla eşleştirilmesi bir sonraki aşamada bu panele
          eklenecek.
        </p>
      </section>
    </div>
  );
}
