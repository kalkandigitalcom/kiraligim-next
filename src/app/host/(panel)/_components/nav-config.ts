import { CalendarDays, CalendarRange, House, LayoutDashboard, type LucideIcon } from "lucide-react";

/**
 * Panel kenar çubuğu menüsü. Yeni bir bölüm eklemek için ilgili gruba öğe ekleyin (ya da yeni
 * grup açın); kenar çubuğu ve mobil menü bu listeden çizilir. `match` etkin bağlantıyı belirler:
 * alt sayfalar (ör. /villalar/{id}/fiyatlar) üst menü öğesini etkin gösterir.
 */
export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  match: (pathname: string) => boolean;
};

export type NavGroup = {
  id: string;
  /** Grup başlığı; tek grupta gösterilmez. */
  label?: string;
  items: readonly NavItem[];
};

const under = (base: string) => (p: string) => p === base || p.startsWith(`${base}/`);

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "ana",
    items: [
      { href: "/panel", label: "Genel Bakış", icon: LayoutDashboard, match: under("/panel") },
      { href: "/villalar", label: "Mülkler", icon: House, match: under("/villalar") },
      {
        href: "/rezervasyonlar",
        label: "Rezervasyonlar",
        icon: CalendarRange,
        match: under("/rezervasyonlar"),
      },
      { href: "/takvim", label: "Takvim", icon: CalendarDays, match: under("/takvim") },
    ],
  },
];

/** Yoldaki etkin menü öğesi (yoksa null). */
export function activeNavHref(pathname: string): string | null {
  for (const g of NAV_GROUPS) for (const i of g.items) if (i.match(pathname)) return i.href;
  return null;
}
