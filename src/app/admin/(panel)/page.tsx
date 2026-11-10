import type { Metadata } from "next";
import Link from "next/link";

import { requireAdmin } from "@/server/admin/session";
import { groupTab, listAdminConnections, listAdminGroups } from "@/server/admin/whatsapp";

export const metadata: Metadata = { title: "Platform yönetimi" };

const CONNECTION: Record<string, string> = {
  open: "Bağlı",
  connecting: "Bağlanıyor",
  closed: "Bağlantı yok",
  logged_out: "Oturum kapalı (QR gerekli)",
};

export default async function AdminHomePage() {
  const admin = await requireAdmin();
  const [groups, connections] = await Promise.all([
    listAdminGroups(admin.ctx.db, admin.adminId),
    listAdminConnections(admin.ctx.db, admin.adminId),
  ]);
  const pending = groups.filter((g) => groupTab(g) === "bekleyen").length;
  const active = groups.filter((g) => groupTab(g) === "aktif").length;
  const conn = connections[0];
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
      <section className="grid gap-4 sm:grid-cols-3">
        <Link
          href="/whatsapp?sekme=bekleyen"
          className="rounded-2xl border border-border bg-white p-5 shadow-sm hover:bg-mist/60"
          data-testid="admin-pending-count"
        >
          <p className="text-sm text-muted-foreground">Eşleştirme bekleyen grup</p>
          <p className="mt-1 text-3xl font-bold text-navy-900">{pending}</p>
        </Link>
        <Link
          href="/whatsapp?sekme=aktif"
          className="rounded-2xl border border-border bg-white p-5 shadow-sm hover:bg-mist/60"
        >
          <p className="text-sm text-muted-foreground">Aktif grup</p>
          <p className="mt-1 text-3xl font-bold text-navy-900">{active}</p>
        </Link>
        <div className="rounded-2xl border border-border bg-white p-5 shadow-sm">
          <p className="text-sm text-muted-foreground">WhatsApp Gateway</p>
          <p className="mt-1 text-lg font-semibold text-navy-900">
            {conn ? (CONNECTION[conn.status] ?? conn.status) : "Kayıt yok"}
          </p>
        </div>
      </section>
    </div>
  );
}
