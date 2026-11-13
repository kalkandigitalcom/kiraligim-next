import { Logo } from "@/components/brand/logo";
import { MAINTENANCE_COPY } from "@/config/marketing";

/**
 * Geçici bakım ekranı (SITE_MAINTENANCE). Sunucuda çizilir, istemci betiği yoktur. Yalnız
 * globals.css'teki mevcut site-* yardımcıları kullanılır (CSP: satır içi stil yok); hareketler
 * prefers-reduced-motion: reduce iken kapalıdır.
 */
export function MaintenanceScreen() {
  const year = new Date().getFullYear();
  return (
    <div className="relative isolate flex min-h-dvh flex-1 flex-col overflow-hidden bg-navy-900 text-white">
      <div aria-hidden="true" className="absolute inset-0 -z-10 site-grid-dark opacity-60" />
      <div aria-hidden="true" className="absolute inset-0 -z-10 site-glow-dark" />
      <div
        aria-hidden="true"
        className="site-float-slow absolute -top-40 left-1/2 -z-10 size-[36rem] -translate-x-1/2 rounded-full bg-turquoise-500/10 blur-3xl"
      />

      <header className="mx-auto flex w-full max-w-6xl items-center justify-center px-5 py-6 sm:px-8 sm:py-8">
        <Logo variant="ters" className="site-rise h-7 w-auto sm:h-8" alt="Kiralığım" />
      </header>

      <main
        id="icerik"
        className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-5 pb-16 text-center sm:px-8"
      >
        <p className="site-rise site-d1 inline-flex items-center gap-2 rounded-full border border-turquoise-500/30 bg-turquoise-500/10 px-3.5 py-1.5 text-xs font-semibold tracking-[0.14em] text-turquoise-50 uppercase">
          <span aria-hidden="true" className="site-blink size-2 rounded-full bg-turquoise-500" />
          {MAINTENANCE_COPY.badge}
        </p>

        <h1 className="site-rise site-d2 mt-7 text-4xl leading-[1.08] font-semibold tracking-tight text-balance sm:text-6xl">
          {MAINTENANCE_COPY.title}
        </h1>

        <p className="site-rise site-d3 mt-6 max-w-2xl text-base leading-relaxed text-pretty text-white/70 sm:text-lg">
          {MAINTENANCE_COPY.description}
        </p>

        <div
          aria-hidden="true"
          className="site-rise site-d4 mt-10 h-px w-40 bg-gradient-to-r from-transparent via-turquoise-500 to-transparent"
        />

        <p className="site-rise site-d5 mt-10 text-lg font-medium text-white">
          {MAINTENANCE_COPY.footnote}
        </p>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-5 pb-8 text-center text-xs text-white/40 sm:px-8">
        © {year} Kiralığım
      </footer>
    </div>
  );
}
