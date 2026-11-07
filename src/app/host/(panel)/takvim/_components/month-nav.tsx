"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";

import { useCalendarSelection } from "./calendar-selection";

const NAV_LINK =
  "inline-flex h-9 items-center rounded-lg border border-border bg-white px-3 text-sm font-medium text-navy-900 transition-colors hover:bg-mist focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none";

type Props = {
  monthLabel: string;
  prevHref: string | null;
  nextHref: string | null;
  /** Bugünün ayına dönüş (zaten bugünün ayındaysa null). */
  todayHref: string | null;
};

/**
 * Ay gezinme. Giriş günü seçilmiş ama çıkış henüz seçilmemişse bağlantılar bekleyen girişi
 * ?baslangic ile taşır (yalnız tarih; kişisel veri yok), böylece aralık ay sınırını aşabilir.
 */
export function MonthNav({ monthLabel, prevHref, nextHref, todayHref }: Props) {
  const { selection } = useCalendarSelection();
  const pending = selection.start && !selection.end ? selection.start : null;
  const withPending = (href: string) => {
    if (!pending) return href;
    const [path, query = ""] = href.split("?");
    const p = new URLSearchParams(query);
    p.set("baslangic", pending);
    return `${path}?${p.toString()}`;
  };
  return (
    <nav aria-label="Ay gezinme" className="flex items-center justify-between gap-2">
      {prevHref ? (
        <Link href={withPending(prevHref)} className={NAV_LINK} aria-label="Önceki ay">
          ‹<span className="ml-1 hidden sm:inline">Önceki</span>
        </Link>
      ) : (
        <span className={cn(NAV_LINK, "pointer-events-none opacity-40")} aria-hidden>
          ‹
        </span>
      )}
      <h2 className="min-w-36 text-center text-lg font-semibold text-navy-900" aria-live="polite">
        {monthLabel}
      </h2>
      {nextHref ? (
        <Link href={withPending(nextHref)} className={NAV_LINK} aria-label="Sonraki ay">
          <span className="mr-1 hidden sm:inline">Sonraki</span>›
        </Link>
      ) : (
        <span className={cn(NAV_LINK, "pointer-events-none opacity-40")} aria-hidden>
          ›
        </span>
      )}
      {todayHref ? (
        <Link href={withPending(todayHref)} className={NAV_LINK}>
          Bugün
        </Link>
      ) : null}
    </nav>
  );
}
