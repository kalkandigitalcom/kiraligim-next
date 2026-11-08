"use client";

import { formatNights } from "@/lib/rate-meta";
import { segmentFormula, unpricedSummary } from "@/lib/pricing";
import { cleaningNote, STAY_INVALID_MESSAGES, type StayEvaluation } from "@/lib/public-stay";
import type { RatePeriod } from "@/lib/rate-meta";
import { startingNightly } from "@/lib/public-villa-view";
import { formatDay, formatMoney, formatStay } from "@/lib/reservation-meta";
import { cn } from "@/lib/utils";

import { useStay } from "./stay-context";

/**
 * Seçilen konaklamanın teklifi (F2c). Tutar yalnız quoteStay geçerliyken gösterilir; minimum
 * konaklama karşılanmıyorsa veya fiyatsız gece varsa toplam GÖSTERİLMEZ. Hiçbir şey kaydedilmez.
 */
export function StayQuote() {
  const {
    evaluation: e,
    maxGuests,
    guests,
    setGuests,
    whatsappHref,
    rates,
    requestEnabled,
  } = useStay();
  const canRequest = e.state === "quote" || e.state === "unpriced";
  return (
    <div className="flex flex-col gap-4" data-testid="stay-quote" data-state={e.state}>
      <label className="flex max-w-xs flex-col gap-1.5 text-sm font-medium">
        Kişi sayısı
        <select
          value={guests}
          onChange={(ev) => setGuests(Number(ev.target.value))}
          className="h-11 rounded-lg border border-border bg-white px-3 text-[15px] focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
          data-testid="stay-guests"
        >
          {Array.from({ length: maxGuests }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n} kişi
            </option>
          ))}
        </select>
      </label>

      {/* Seçim değiştikçe sonuç ekran okuyuculara duyurulur. */}
      <div aria-live="polite">
        <QuoteBody e={e} rates={rates} />
      </div>

      {e.state !== "empty" && e.state !== "checkout" && (
        <div className="flex flex-wrap gap-2">
          {canRequest && requestEnabled ? (
            <a
              href="#rezervasyon"
              className="inline-flex h-12 items-center justify-center rounded-xl bg-navy-900 px-5 text-[15px] font-semibold text-white transition-colors hover:bg-navy-800 focus-visible:ring-3 focus-visible:ring-turquoise-500/50 focus-visible:outline-none"
              data-testid="stay-to-request"
            >
              Rezervasyon talebi gönder
            </a>
          ) : null}
          <WaLink
            href={whatsappHref}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-[#1f7a4d] px-5 text-[15px] font-semibold text-white transition-colors hover:bg-[#186540] focus-visible:ring-3 focus-visible:ring-turquoise-500/50 focus-visible:outline-none"
            testId="stay-whatsapp"
          >
            <WhatsAppIcon />
            {e.state === "quote" ? "Bu tarihler için WhatsApp'tan sorun" : "WhatsApp'tan sorun"}
          </WaLink>
        </div>
      )}
    </div>
  );
}

/**
 * Seçimin sonucu: uyarı ya da fiyat dökümü. Hem rezervasyon kartında hem sayfadaki hesaplayıcıda
 * aynı bileşen kullanılır (tek fiyat gösterimi). `compact`: kartta daha sıkı yerleşim ve kartın
 * kendi açıklaması.
 */
export function QuoteBody({
  e,
  rates,
  compact = false,
}: {
  e: StayEvaluation;
  rates: readonly RatePeriod[];
  compact?: boolean;
}) {
  switch (e.state) {
    case "empty":
      return null;
    case "checkout":
      return (
        <p className="text-[15px]">
          Giriş: <strong>{formatDay(e.checkIn)}</strong>. Şimdi çıkış tarihini seçin.
        </p>
      );
    case "invalid":
      return <Notice tone="warn">{STAY_INVALID_MESSAGES[e.reason]}</Notice>;
    case "min-nights":
      return (
        <Notice tone="warn" testId={compact ? "booking-min-nights" : "stay-min-nights"}>
          {formatStay(e.checkIn, e.checkOut)} ({e.nights} gece): bu tarihlerde en az {e.required}{" "}
          gece konaklama gerekir. Daha uzun bir aralık seçin ya da ev sahibine yazın.
        </Notice>
      );
    case "unpriced": {
      const missing = unpricedSummary(e.quote);
      return (
        <Notice tone="info" testId={compact ? "booking-unpriced" : "stay-unpriced"}>
          {formatStay(e.checkIn, e.checkOut)} ({e.nights} gece) için toplam tutar hesaplanamıyor
          {missing ? `: ${missing} için fiyat girilmemiş` : ""}. Fiyat bilgisini ev sahibinden
          isteyebilirsiniz.
        </Notice>
      );
    }
    case "quote": {
      const q = e.quote;
      const c = q.currency!;
      const cleaning = cleaningNote(q, rates);
      return (
        <div
          className={cn(
            "rounded-2xl border border-border bg-mist/50",
            compact ? "p-3.5 text-sm" : "p-4 sm:p-5",
          )}
          data-testid={compact ? "booking-price" : "stay-total-box"}
        >
          <p className="font-semibold">
            {formatStay(e.checkIn, e.checkOut)} · {e.nights} gece
          </p>
          <dl className={cn("mt-3 flex flex-col gap-2", compact ? "text-sm" : "text-[15px]")}>
            {q.segments.map((s) => (
              <div
                key={`${s.periodId}-${s.from}`}
                className="flex flex-wrap justify-between gap-x-4"
              >
                <dt className="text-navy-900/70">
                  {formatNights(s.from, s.to)}: {segmentFormula(s, c)}
                </dt>
                <dd className="font-medium">{formatMoney(s.subtotalMinor ?? 0, c)}</dd>
              </div>
            ))}
            {q.cleaningFee && (
              <div className="flex flex-wrap justify-between gap-x-4">
                <dt className="text-navy-900/70">Temizlik ücreti</dt>
                <dd className="font-medium">{formatMoney(q.cleaningFee.amountMinor, c)}</dd>
              </div>
            )}
            {cleaning?.kind === "free" && (
              <div
                className="flex flex-wrap justify-between gap-x-4"
                data-testid={compact ? "booking-cleaning-free" : undefined}
              >
                <dt className="text-navy-900/70">Temizlik ücreti</dt>
                <dd className="font-medium text-turquoise-700">
                  Ücretsiz ({cleaning.freeFromNights}+ gece)
                </dd>
              </div>
            )}
            <div
              className={cn(
                "mt-1 flex flex-wrap justify-between gap-x-4 border-t border-border pt-3",
                compact ? "text-base" : "text-lg",
              )}
            >
              <dt className="font-bold">Toplam</dt>
              <dd className="font-extrabold" data-testid={compact ? "booking-total" : "stay-total"}>
                {formatMoney(q.totalMinor!, c)}
              </dd>
            </div>
          </dl>
          {cleaning?.kind === "charged" && cleaning.freeFromNights !== null ? (
            <p className="mt-2 text-sm text-navy-900/60">
              {cleaning.freeFromNights} gece ve üzeri konaklamalarda temizlik ücreti alınmaz.
            </p>
          ) : null}
          <p className="mt-3 text-sm text-navy-900/60">
            {compact
              ? "Fiyat sayfadaki dönem fiyatlarına göre hesaplandı; talebiniz gönderilirken yeniden hesaplanır. Rezervasyon, ev sahibi onayladığında kesinleşir."
              : "Bu tutar bilgilendirme amaçlıdır; rezervasyon oluşturmaz. Müsaitliği ve kesin fiyatı ev sahibi teyit eder."}
          </p>
        </div>
      );
    }
  }
}

export function Notice({
  tone,
  testId,
  children,
}: {
  tone: "warn" | "info";
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <p
      role="status"
      data-testid={testId}
      className={cn(
        "rounded-2xl border p-4 text-[15px]",
        tone === "warn"
          ? "border-amber-300 bg-amber-50 text-amber-950"
          : "border-border bg-mist text-navy-900",
      )}
    >
      {children}
    </p>
  );
}

/**
 * Mobil alt çubuk: sayfanın sonuna kadar ekranın altında kalır (sticky; alt bilgiyi örtmez).
 * Ana eylem rezervasyon kartına götürür (tek form; kart mobilde içerikte); WhatsApp ikincil.
 */
export function MobileStayBar() {
  const { evaluation: e, rates, currency, whatsappHref } = useStay();
  const from = currency ? startingNightly(rates, currency) : null;
  const quote = e.state === "quote" ? e : null;
  const ready = e.state === "quote" || e.state === "unpriced";
  return (
    <div
      className="sticky bottom-0 z-30 -mx-4 mt-10 border-t border-border bg-white/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:hidden"
      data-testid="mobile-stay-bar"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          {quote ? (
            <>
              <p className="truncate text-sm text-navy-900/65">
                {formatStay(quote.checkIn, quote.checkOut)} · {quote.nights} gece
              </p>
              <p className="text-lg font-extrabold">
                {formatMoney(quote.quote.totalMinor!, quote.quote.currency!)}
              </p>
            </>
          ) : from !== null && currency ? (
            <>
              <p className="text-sm text-navy-900/65">Gecelik başlangıç</p>
              <p className="text-lg font-extrabold">{formatMoney(from, currency)}</p>
            </>
          ) : (
            <p className="text-sm text-navy-900/75">Fiyat için ev sahibine yazın</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <WaLink
            href={whatsappHref}
            className="inline-flex size-11 items-center justify-center rounded-xl bg-[#1f7a4d] text-white focus-visible:ring-3 focus-visible:ring-turquoise-500/50 focus-visible:outline-none"
            testId="mobile-whatsapp"
          >
            <WhatsAppIcon />
            <span className="sr-only">WhatsApp ile iletişime geç</span>
          </WaLink>
          <a
            href="#rezervasyon"
            className="inline-flex h-11 items-center rounded-xl bg-navy-900 px-4 text-[15px] font-semibold text-white focus-visible:ring-3 focus-visible:ring-turquoise-500/50 focus-visible:outline-none"
            data-testid="mobile-to-request"
          >
            {ready ? "Talep gönder" : "Tarih seçin"}
          </a>
        </div>
      </div>
    </div>
  );
}

/**
 * WhatsApp bağlantısı. Numara yoksa (yalnız panel önizlemesinde olabilir) bağlantı yerine devre
 * dışı görünüm ve açıklama: tıklanınca boş bir WhatsApp sohbeti açılmaz.
 */
export function WaLink({
  href,
  className,
  testId,
  children,
}: {
  href: string | null;
  className: string;
  testId?: string;
  children: React.ReactNode;
}) {
  if (!href) {
    return (
      <span
        role="link"
        aria-disabled="true"
        title="İşletmenin WhatsApp numarası tanımlı değil"
        className={cn(className, "cursor-not-allowed opacity-50")}
        data-testid={testId}
        data-disabled="true"
      >
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      data-testid={testId}
    >
      {children}
    </a>
  );
}

export const WhatsAppIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 fill-current">
    <path d="M12 2.2a9.7 9.7 0 00-8.3 14.8L2.5 21.8l4.9-1.3A9.7 9.7 0 1012 2.2zm0 17.7a8 8 0 01-4.1-1.1l-.3-.2-2.9.8.8-2.8-.2-.3A8 8 0 1112 19.9zm4.4-6c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1l-.8 1c-.1.2-.3.2-.5.1a6.6 6.6 0 01-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.5-.4h-.5a.9.9 0 00-.7.3 2.8 2.8 0 00-.9 2.1 4.9 4.9 0 001 2.6 11.2 11.2 0 004.3 3.8c1.6.7 2.2.7 3 .6a2.6 2.6 0 001.7-1.2 2.1 2.1 0 00.1-1.2c0-.1-.2-.2-.4-.3z" />
  </svg>
);
