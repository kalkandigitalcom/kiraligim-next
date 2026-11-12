import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { requireAdmin } from "@/server/admin/session";

import { adminLogoutAction } from "./actions";

/**
 * Super Admin paneli çerçevesi. Her sayfa geçerli yönetici oturumu ister (2FA ile açılmış);
 * yoksa /giris. İşletme paneliyle (app.<alan-adı>) hiçbir ortak oturum veya menü yoktur.
 */
export default async function AdminPanelLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  return (
    <div className="flex min-h-dvh flex-1 flex-col bg-mist">
      <header className="bg-navy-900 text-white">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <Logo variant="ters" className="h-7 w-auto" />
            <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-semibold tracking-wide uppercase">
              Platform yönetimi
            </span>
            <nav aria-label="Yönetim" className="flex gap-1 text-sm">
              <Link href="/" className="rounded-lg px-2.5 py-1.5 hover:bg-white/10">
                Genel bakış
              </Link>
              <Link href="/whatsapp" className="rounded-lg px-2.5 py-1.5 hover:bg-white/10">
                WhatsApp grupları
              </Link>
              <Link href="/api-musterileri" className="rounded-lg px-2.5 py-1.5 hover:bg-white/10">
                API müşterileri
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-white/75" data-testid="admin-name">
              {admin.name}
            </span>
            <form action={adminLogoutAction}>
              <button
                type="submit"
                className="rounded-lg border border-white/20 px-3 py-1.5 font-medium hover:bg-white/10"
              >
                Çıkış
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
