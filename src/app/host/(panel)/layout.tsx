import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { requireUser } from "@/server/auth/session";

import { PanelNav } from "./_components/panel-nav";
import { SignOutButton } from "./_components/sign-out-button";

/**
 * Korumalı panel bölümü. Oturum yoksa her istekte /giris'e yönlendirilir.
 * Sayfalar ayrıca requireUser() çağırır (layout'lar her gezinmede yeniden çalışmayabilir).
 */
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div className="flex min-h-dvh flex-1 flex-col bg-mist">
      <header className="border-b border-border bg-white">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-6">
            <Link href="/" aria-label="Ana sayfa" className="shrink-0">
              <Logo className="h-7 w-auto" />
            </Link>
            <PanelNav className="hidden sm:block" />
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <span className="hidden truncate text-sm text-muted-foreground sm:inline">
              {user.name}
            </span>
            <SignOutButton />
          </div>
        </div>
        <div className="border-t border-border px-2 py-1.5 sm:hidden">
          <PanelNav />
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-10">{children}</main>
    </div>
  );
}
