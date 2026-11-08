import Link from "next/link";

import { cn } from "@/lib/utils";

type Props = {
  propertyId: string;
  active: "info" | "rates" | "publish" | "ical";
};

/**
 * Mülk sayfası sekmeleri: Bilgiler · Fiyatlar · Yayın · Takvim bağlantıları (iCal içe/dışa
 * aktarma, 3.1) · Takvim (takvim sayfasına, bu mülk seçili). Fotoğraflar Bilgiler sihirbazının 2. adımındadır (Aşama 3). Yayın: müşteriye açık villa
 * sayfası ayarları.
 */
export function PropertyTabs({ propertyId, active }: Props) {
  const tabs = [
    { key: "info", href: `/villalar/${propertyId}`, label: "Bilgiler" },
    { key: "rates", href: `/villalar/${propertyId}/fiyatlar`, label: "Fiyatlar" },
    { key: "publish", href: `/villalar/${propertyId}/yayin`, label: "Yayın" },
    {
      key: "ical",
      href: `/villalar/${propertyId}/takvim-baglantilari`,
      label: "Takvim bağlantıları",
      // Dar ekranda kısa ad: beş sekme 390 px'te kaydırmadan sığar.
      short: "iCal",
    },
    { key: "calendar", href: `/takvim?mulk=${propertyId}`, label: "Takvim" },
  ] as const satisfies readonly { key: string; href: string; label: string; short?: string }[];
  return (
    <nav
      aria-label="Mülk bölümleri"
      className="-mx-4 flex gap-1 overflow-x-auto px-4 shadow-[inset_0_-1px_0_var(--color-border)] sm:mx-0 sm:px-0"
    >
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? "page" : undefined}
          className={cn(
            "shrink-0 border-b-2 px-2.5 py-2 text-sm font-semibold whitespace-nowrap transition-colors sm:px-3",
            active === t.key
              ? "border-turquoise-500 text-navy-900"
              : "border-transparent text-muted-foreground hover:text-navy-900",
          )}
        >
          {"short" in t ? (
            <>
              <span className="sm:hidden">{t.short}</span>
              <span className="hidden sm:inline">{t.label}</span>
            </>
          ) : (
            t.label
          )}
        </Link>
      ))}
    </nav>
  );
}
