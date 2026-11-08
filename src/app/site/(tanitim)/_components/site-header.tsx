import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { NAV_ITEMS, SITE_COPY, type SignupCta } from "@/config/marketing";

import { TrialLink } from "./trial-link";

/**
 * Yapışkan üst bar (kaydırınca gölge: MotionRoot). Mobil menü <details> ile açılır: JavaScript
 * gerekmez (CSP, hız).
 */
export function SiteHeader({ trial, loginHref }: { trial: SignupCta; loginHref: string }) {
  return (
    <header className="site-header sticky top-0 z-40 border-b border-transparent bg-white/80 backdrop-blur-xl transition-shadow duration-300">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-6 px-4 sm:px-6 lg:h-[4.5rem]">
        <Link
          href="/"
          className="shrink-0 rounded-md focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
        >
          <Logo className="h-7 w-auto lg:h-8" alt="Kiralığım ana sayfa" />
        </Link>
        <nav
          aria-label="Ana menü"
          className="hidden flex-1 items-center justify-center gap-1 lg:flex"
        >
          {NAV_ITEMS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-2 text-[15px] font-medium text-navy-900/75 transition-colors hover:bg-mist hover:text-navy-900"
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto hidden items-center gap-2 lg:ml-0 lg:flex">
          <a
            href={loginHref}
            className="rounded-lg px-3 py-2 text-[15px] font-semibold text-navy-900 hover:bg-mist"
          >
            {SITE_COPY.loginLabel}
          </a>
          <TrialLink cta={trial} />
        </div>

        <details className="site-menu relative ml-auto lg:hidden">
          <summary
            aria-label="Menü"
            className="flex size-10 cursor-pointer items-center justify-center rounded-lg text-navy-900 hover:bg-mist focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="size-6 fill-none stroke-current stroke-2"
            >
              <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
            </svg>
          </summary>
          <div className="absolute top-12 right-0 flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-1 rounded-2xl border border-border bg-white p-3 shadow-2xl shadow-navy-900/15">
            <nav aria-label="Mobil menü" className="flex flex-col">
              {NAV_ITEMS.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="rounded-lg px-3 py-2.5 text-[15px] font-medium text-navy-900 hover:bg-mist"
                >
                  {item.label}
                </a>
              ))}
            </nav>
            <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3">
              <TrialLink cta={trial} className="w-full" />
              <a
                href={loginHref}
                className="rounded-lg px-3 py-2.5 text-center text-sm font-semibold text-navy-900 hover:bg-mist"
              >
                {SITE_COPY.loginLabel}
              </a>
            </div>
          </div>
        </details>
      </div>
    </header>
  );
}
