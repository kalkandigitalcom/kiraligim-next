"use client";

import { formatNights } from "@/lib/rate-meta";
import { segmentFormula, unpricedSummary } from "@/lib/pricing";
import { STAY_INVALID_MESSAGES, type StayEvaluation } from "@/lib/public-stay";
import { startingNightly } from "@/lib/public-villa-view";
import { formatDay, formatMoney, formatStay } from "@/lib/reservation-meta";
import { cn } from "@/lib/utils";

import { useStay } from "./stay-context";

/**
 * Seçilen konaklamanın teklifi (F2c). Tutar yalnız quoteStay geçerliyken gösterilir; minimum
 * konaklama karşılanmıyorsa veya fiyatsız gece varsa toplam GÖSTERİLMEZ. Hiçbir şey kaydedilmez.
 */
export function StayQuote() {
  const { evaluation: e, maxGuests, guests, setGuests, whatsappHref } = useStay();
  return (
    <div className="flex flex-col gap-4" data-testid="stay-quote" data-state={e.state}>
      <label className="flex max-w-xs flex-col gap-1.5 text-sm font-medium">
        Kişi sayısı (isteğe bağlı)
        <select
          value={guests ?? ""}
          onChange={(ev) => setGuests(ev.target.value ? Number(ev.target.value) : null)}
          className="h-11 rounded-lg border border-border bg-white px-3 text-[15px] focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
          data-testid="stay-guests"
        >
          <option value="">Seçilmedi</option>
          {Array.from({ length: maxGuests }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n} kişi
            </option>
          ))}
        </select>
      </label>

      {/* Seçim değiştikçe sonuç ekran okuyuculara duyurulur. */}
      <div aria-live="polite">
        <QuoteBody e={e} />
      </div>

      {e.state !== "empty" && e.state !== "checkout" && (
        <WaLink
          href={whatsappHref}
          className="inline-flex h-12 items-center justify-center gap-2 self-start rounded-xl bg-[#1f7a4d] px-5 text-[15px] font-semibold text-white transition-colors hover:bg-[#186540] focus-visible:ring-3 focus-visible:ring-turquoise-500/50 focus-visible:outline-none"
          testId="stay-whatsapp"
        >
          <WhatsAppIcon />
          {e.state === "quote" ? "Bu tarihler için WhatsApp'tan sorun" : "WhatsApp'tan sorun"}
        </WaLink>
      )}
    </div>
  );
}

function QuoteBody({ e }: { e: StayEvaluation }) {
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
        <Notice tone="warn" testId="stay-min-nights">
          {formatStay(e.checkIn, e.checkOut)} ({e.nights} gece): bu tarihlerde en az {e.required}{" "}
          gece konaklama gerekir. Daha uzun bir aralık seçin ya da ev sahibine yazın.
        </Notice>
      );
    case "unpriced": {
      const missing = unpricedSummary(e.quote);
      return (
        <Notice tone="info" testId="stay-unpriced">
          {formatStay(e.checkIn, e.checkOut)} ({e.nights} gece) için toplam tutar hesaplanamıyor
          {missing ? `: ${missing} için fiyat girilmemiş` : ""}. Fiyat bilgisini ev sahibinden
          isteyebilirsiniz.
        </Notice>
      );
    }
    case "quote": {
      const q = e.quote;
      const c = q.currency!;
      return (
        <div
          className="rounded-2xl border border-border bg-mist/50 p-4 sm:p-5"
          data-testid="stay-total-box"
        >
          <p className="font-semibold">
            {formatStay(e.checkIn, e.checkOut)} · {e.nights} gece
          </p>
          <dl className="mt-3 flex flex-col gap-2 text-[15px]">
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
            <div className="mt-1 flex flex-wrap justify-between gap-x-4 border-t border-border pt-3 text-lg">
              <dt className="font-bold">Toplam</dt>
              <dd className="font-extrabold" data-testid="stay-total">
                {formatMoney(q.totalMinor!, c)}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-sm text-navy-900/60">
            Bu tutar bilgilendirme amaçlıdır; rezervasyon oluşturmaz. Müsaitliği ve kesin fiyatı ev
            sahibi teyit eder.
          </p>
        </div>
      );
    }
  }
}

function Notice({
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
 * Yan kart (masaüstü) ve içerik kartı (mobil): seçim yoksa başlangıç fiyatı; geçerli seçimde
 * tarih ve toplam. WhatsApp mesajı seçime göre hazırlanır.
 */
export function StayCard({ className }: { className?: string }) {
  const { evaluation: e, rates, currency, maxGuests, whatsappHref } = useStay();
  const from = currency ? startingNightly(rates, currency) : null;
  return (
    <div
      className={cn(
        "rounded-3xl border border-border bg-white p-5 shadow-xl shadow-navy-900/5 sm:p-6",
        className,
      )}
      data-testid="villa-contact"
    >
      {e.state === "quote" ? (
        <div className="mb-4">
          <p className="text-sm text-navy-900/60">
            {formatStay(e.checkIn, e.checkOut)} · {e.nights} gece
          </p>
          <p className="text-2xl font-extrabold tracking-tight">
            {formatMoney(e.quote.totalMinor!, e.quote.currency!)}
          </p>
        </div>
      ) : from !== null && currency ? (
        <div className="mb-4">
          <p className="text-sm text-navy-900/60">Gecelik başlangıç fiyatı</p>
          <p className="text-2xl font-extrabold tracking-tight">{formatMoney(from, currency)}</p>
        </div>
      ) : (
        <p className="mb-4 text-[15px] text-navy-900/75">
          Fiyat ve müsaitlik için ev sahibine yazın.
        </p>
      )}
      <WaLink
        href={whatsappHref}
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#1f7a4d] px-4 text-[15px] font-semibold text-white transition-colors hover:bg-[#186540] focus-visible:ring-3 focus-visible:ring-turquoise-500/50 focus-visible:outline-none"
        testId="villa-whatsapp"
      >
        <WhatsAppIcon />
        WhatsApp&apos;tan sorun
      </WaLink>
      {e.state !== "quote" && (
        <a
          href="#musaitlik"
          className="mt-2 inline-flex h-11 w-full items-center justify-center rounded-xl border border-border text-[15px] font-semibold hover:bg-mist focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
        >
          Tarih seçip fiyat hesaplayın
        </a>
      )}
      {whatsappHref === null ? (
        <p className="mt-2 text-sm text-amber-900" data-testid="whatsapp-missing">
          İşletmenin WhatsApp numarası tanımlı değil; müşteri iletişim düğmesini kullanamaz.
        </p>
      ) : null}
      <p className="mt-3 text-sm text-navy-900/60">
        En fazla {maxGuests} kişi. Müsaitlik ve kesin fiyat için ev sahibiyle doğrudan iletişime
        geçersiniz.
      </p>
    </div>
  );
}

/** Mobil alt çubuk: sayfanın sonuna kadar ekranın altında kalır (sticky; alt bilgiyi örtmez). */
export function MobileStayBar() {
  const { evaluation: e, rates, currency, whatsappHref } = useStay();
  const from = currency ? startingNightly(rates, currency) : null;
  const quote = e.state === "quote" ? e : null;
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
        {quote ? (
          <WaLink
            href={whatsappHref}
            className="inline-flex h-11 shrink-0 items-center gap-2 rounded-xl bg-[#1f7a4d] px-4 text-[15px] font-semibold text-white focus-visible:ring-3 focus-visible:ring-turquoise-500/50 focus-visible:outline-none"
          >
            <WhatsAppIcon />
            Sor
          </WaLink>
        ) : (
          <a
            href="#musaitlik"
            className="inline-flex h-11 shrink-0 items-center rounded-xl bg-navy-900 px-4 text-[15px] font-semibold text-white focus-visible:ring-3 focus-visible:ring-turquoise-500/50 focus-visible:outline-none"
          >
            Tarih seçin
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * WhatsApp bağlantısı. Numara yoksa (yalnız panel önizlemesinde olabilir) bağlantı yerine devre
 * dışı görünüm ve açıklama: tıklanınca boş bir WhatsApp sohbeti açılmaz.
 */
function WaLink({
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
