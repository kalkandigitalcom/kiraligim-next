import Link from "next/link";

import { Logo } from "@/components/brand/logo";

/**
 * Müşteriye açık villa sayfaları (kök alan adı, /villa/{slug}). Tanıtım sitesinin üst bar ve alt
 * bilgisi burada yoktur: sayfa villanın kendisidir, marka yalnız sade bir çerçevedir. İşletme adı
 * gösterilmez (F2 kararı).
 */
export default function VillaLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col bg-white text-navy-900">
      <a
        href="#icerik"
        className="sr-only z-50 rounded-lg bg-navy-900 px-4 py-2 text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        İçeriğe geç
      </a>
      <main id="icerik" className="flex flex-1 flex-col">
        {children}
      </main>
      <footer className="border-t border-border bg-mist">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start gap-3 px-4 py-8 text-sm text-navy-900/65 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>
            Fiyat ve müsaitlik bilgisi bilgilendirme amaçlıdır; kesin teklif için ev sahibiyle
            iletişime geçin.
          </p>
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 rounded-md text-navy-900/70 hover:text-navy-900 focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
          >
            <span>Hazırlayan</span>
            <Logo className="h-5 w-auto" alt="Kiralığım" />
          </Link>
        </div>
      </footer>
    </div>
  );
}
