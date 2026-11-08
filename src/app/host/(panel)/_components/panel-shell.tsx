"use client";

import { ArrowLeftRight, Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/utils";

import { SignOutButton } from "../../_components/sign-out-button";
import { activeNavHref, NAV_GROUPS } from "./nav-config";

export type ShellUser = { name: string; email: string };
export type ShellWorkspace = { name: string; roleLabel: string; canSwitch: boolean } | null;

/**
 * Panel çerçevesi: masaüstünde (lg ve üzeri) sabit sol kenar çubuğu, daha dar ekranlarda üst
 * şerit + hamburger ile açılan çekmece (<dialog>: odak içeride kalır, Esc kapatır, kapanınca odak
 * menü düğmesine döner). Sayfa değişince çekmece kapanır. Satır içi stil yok (CSP).
 */
export function PanelShell({
  user,
  workspace,
  children,
}: {
  user: ShellUser;
  workspace: ShellWorkspace;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  const openDrawer = () => {
    const d = dialogRef.current;
    if (!d || d.open) return;
    d.showModal();
    setOpen(true);
    document.documentElement.classList.add("overflow-hidden");
  };
  const closeDrawer = () => dialogRef.current?.close();

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    const onClose = () => {
      setOpen(false);
      document.documentElement.classList.remove("overflow-hidden");
    };
    d.addEventListener("close", onClose);
    return () => {
      d.removeEventListener("close", onClose);
      document.documentElement.classList.remove("overflow-hidden");
    };
  }, []);

  // Sayfa değişince (çekmecedeki bir bağlantıyla ya da geri tuşuyla) çekmece kapanır.
  useEffect(() => {
    dialogRef.current?.close();
  }, [pathname]);

  // Çekmece masaüstü genişliğine geçilirse kapanır (kenar çubuğu zaten görünür).
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => {
      if (mq.matches) dialogRef.current?.close();
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <div className="flex min-h-dvh flex-1 flex-col bg-mist">
      <a
        href="#icerik"
        className="sr-only z-50 rounded-lg bg-navy-900 px-4 py-2 text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        İçeriğe geç
      </a>

      {/* Masaüstü kenar çubuğu */}
      <aside
        className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-border bg-white lg:flex"
        aria-label="Panel"
        data-testid="sidebar"
      >
        <SidebarContent pathname={pathname} user={user} workspace={workspace} />
      </aside>

      {/* Mobil üst şerit */}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-white px-4 sm:px-6 lg:hidden">
        <button
          type="button"
          onClick={openDrawer}
          aria-label="Menüyü aç"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls="panel-menu"
          className="-ml-2 inline-flex size-10 items-center justify-center rounded-lg text-navy-900 hover:bg-mist focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
          data-testid="menu-button"
        >
          <Menu className="size-5" aria-hidden="true" />
        </button>
        <Link
          href="/panel"
          className="rounded-md focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
        >
          <Logo className="h-6 w-auto" alt="Kiralığım – Genel Bakış" />
        </Link>
      </header>

      {/* Mobil çekmece */}
      <dialog
        ref={dialogRef}
        id="panel-menu"
        aria-label="Panel menüsü"
        className="m-0 h-dvh max-h-none w-[min(18rem,85vw)] max-w-none border-r border-border bg-white p-0 backdrop:bg-navy-950/40 lg:hidden"
        onClick={(e) => {
          // Arka plana (dialog'un kendisine) tıklanınca kapanır.
          if (e.target === e.currentTarget) closeDrawer();
        }}
        data-testid="drawer"
      >
        <div className="flex h-full flex-col">
          <SidebarContent
            pathname={pathname}
            user={user}
            workspace={workspace}
            onNavigate={closeDrawer}
            closeButton={
              <button
                type="button"
                onClick={closeDrawer}
                aria-label="Menüyü kapat"
                autoFocus
                className="inline-flex size-10 items-center justify-center rounded-lg text-navy-900 hover:bg-mist focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            }
          />
        </div>
      </dialog>

      <div className="flex flex-1 flex-col lg:pl-64">
        <main
          id="icerik"
          className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-10 lg:px-10"
        >
          {children}
        </main>
      </div>
    </div>
  );
}

function SidebarContent({
  pathname,
  user,
  workspace,
  onNavigate,
  closeButton,
}: {
  pathname: string;
  user: ShellUser;
  workspace: ShellWorkspace;
  onNavigate?: () => void;
  closeButton?: React.ReactNode;
}) {
  const active = activeNavHref(pathname);
  const initials =
    user.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]!.toLocaleUpperCase("tr-TR"))
      .join("") || "?";

  return (
    <>
      <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-5">
        <Link
          href="/panel"
          onClick={onNavigate}
          className="rounded-md focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
        >
          <Logo className="h-7 w-auto" alt="Kiralığım – Genel Bakış" />
        </Link>
        {closeButton}
      </div>

      <nav aria-label="Ana menü" className="flex-1 overflow-y-auto px-3 py-4">
        <div className="flex flex-col gap-6">
          {NAV_GROUPS.map((g) => (
            <div key={g.id}>
              {g.label && NAV_GROUPS.length > 1 ? (
                <p className="mb-2 px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {g.label}
                </p>
              ) : null}
              <ul className="flex flex-col gap-1">
                {g.items.map((item) => {
                  const isActive = active === item.href;
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onNavigate}
                        aria-current={isActive ? "page" : undefined}
                        className={cn(
                          "flex h-10 items-center gap-3 rounded-lg px-3 text-[15px] font-medium transition-colors focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none",
                          isActive
                            ? "bg-turquoise-50 text-turquoise-700"
                            : "text-navy-900/75 hover:bg-mist hover:text-navy-900",
                        )}
                      >
                        <Icon
                          className={cn(
                            "size-[18px] shrink-0",
                            isActive ? "text-turquoise-700" : "text-navy-900/50",
                          )}
                          aria-hidden="true"
                        />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      <div className="shrink-0 border-t border-border p-3" data-testid="sidebar-user">
        <div className="flex items-center gap-3 px-2 py-2">
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-navy-900 text-sm font-semibold text-white"
          >
            {initials}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-navy-900">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          </div>
        </div>
        {workspace ? (
          <div className="mt-1 flex items-center justify-between gap-2 rounded-lg bg-mist px-3 py-2">
            <div className="min-w-0">
              <p
                className="truncate text-sm font-medium text-navy-900"
                data-testid="sidebar-workspace"
              >
                {workspace.name}
              </p>
              <p className="text-xs text-muted-foreground" data-testid="sidebar-role">
                {workspace.roleLabel}
              </p>
            </div>
            {workspace.canSwitch ? (
              <Link
                href="/isletmeler"
                onClick={onNavigate}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-navy-900/70 hover:bg-white hover:text-navy-900 focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
                aria-label="İşletme değiştir"
                title="İşletme değiştir"
              >
                <ArrowLeftRight className="size-4" aria-hidden="true" />
              </Link>
            ) : null}
          </div>
        ) : null}
        <div className="mt-2">
          <SignOutButton appearance="sidebar" />
        </div>
      </div>
    </>
  );
}
