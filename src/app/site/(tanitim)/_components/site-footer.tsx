import { Logo } from "@/components/brand/logo";
import { NAV_ITEMS, SITE_COPY } from "@/config/marketing";

/**
 * Alt bilgi (zemin navy-900: ters logo PNG'si bu renkte opak zeminlidir). İletişim bilgisi ve yasal
 * metin bağlantıları onaylanana kadar yer almaz.
 */
export function SiteFooter({ loginHref }: { loginHref: string }) {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-white/10 bg-navy-900 text-white/75">
      <div className="mx-auto grid w-full max-w-7xl gap-12 px-4 py-16 sm:px-6 md:grid-cols-[1.6fr_1fr_1fr]">
        <div className="flex flex-col gap-5">
          <Logo variant="ters" className="h-8 w-auto self-start" alt="Kiralığım" />
          <p className="max-w-sm text-[15px] leading-relaxed text-white/65">
            {SITE_COPY.description}
          </p>
          <p className="text-2xl font-extrabold tracking-tight text-white">{SITE_COPY.slogan}</p>
        </div>
        <nav aria-label="Alt menü" className="flex flex-col gap-2.5 text-[15px]">
          <p className="mb-1 text-sm font-bold tracking-wide text-white uppercase">Ürün</p>
          {NAV_ITEMS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="w-fit transition-colors hover:text-white"
            >
              {item.label}
            </a>
          ))}
          <a href={loginHref} className="w-fit transition-colors hover:text-white">
            {SITE_COPY.loginLabel}
          </a>
        </nav>
        <div className="flex flex-col gap-2.5 text-[15px]">
          <p className="mb-1 text-sm font-bold tracking-wide text-white uppercase">Yasal</p>
          <p className="text-white/55" data-testid="legal-pending">
            {SITE_COPY.legalPending}
          </p>
        </div>
      </div>
      <div className="border-t border-white/10">
        <p className="mx-auto w-full max-w-7xl px-4 py-6 text-sm text-white/45 sm:px-6">
          © {year} Kiralığım
        </p>
      </div>
    </footer>
  );
}
