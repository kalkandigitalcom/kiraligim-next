"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/panel", label: "Panel", match: (p: string) => p === "/panel" },
  { href: "/villalar", label: "Mülkler", match: (p: string) => p.startsWith("/villalar") },
  {
    href: "/rezervasyonlar",
    label: "Rezervasyonlar",
    match: (p: string) => p.startsWith("/rezervasyonlar"),
  },
  { href: "/takvim", label: "Takvim", match: (p: string) => p.startsWith("/takvim") },
] as const;

/** Panel menüsü. Etkin bağlantı aria-current ile işaretlenir. */
export function PanelNav({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Panel menüsü" className={className}>
      <ul className="-m-1 flex items-center gap-1 overflow-x-auto p-1">
        {ITEMS.map((item) => {
          const active = item.match(pathname);
          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 items-center rounded-lg px-2.5 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none sm:px-3",
                  active
                    ? "bg-turquoise-50 text-turquoise-700"
                    : "text-muted-foreground hover:bg-mist hover:text-navy-900",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
