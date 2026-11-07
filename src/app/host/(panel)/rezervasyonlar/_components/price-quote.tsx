"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { type Quote, quoteMessage, segmentFormula, unpricedSummary } from "@/lib/pricing";
import {
  type Currency,
  formatMoney,
  formatStay,
  isIsoDate,
  minorToInput,
  parseAmount,
  toMinor,
} from "@/lib/reservation-meta";

import { quoteStayAction } from "../actions";

/** Mülk + tarihler hazır olunca fiyatı sunucudan ister (gecikmeli; salt okunur). */
function usePriceQuote(propertyId: string, checkIn: string, checkOut: string) {
  const key = `${propertyId}|${checkIn}|${checkOut}`;
  const ready =
    propertyId !== "" && isIsoDate(checkIn) && isIsoDate(checkOut) && checkOut > checkIn;
  const [result, setResult] = useState<{ key: string; quote: Quote | null } | null>(null);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      quoteStayAction(propertyId, checkIn, checkOut)
        .then((r) => {
          if (!cancelled) setResult({ key, quote: r.quote });
        })
        .catch(() => undefined);
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [ready, key, propertyId, checkIn, checkOut]);
  if (!ready) return { state: "idle" as const };
  if (result?.key !== key) return { state: "loading" as const };
  return { state: "done" as const, quote: result.quote };
}

type Props = {
  propertyId: string;
  propertyName: string;
  checkIn: string;
  checkOut: string;
  /** Formdaki mevcut tutar ve para birimi (karşılaştırma için; DEĞİŞTİRİLMEZ). */
  currentTotal: string;
  currentCurrency: string;
  /** Yalnız kullanıcı "Bu tutarı kullan" dediğinde çağrılır. */
  onUse: (total: string, currency: Currency) => void;
};

/**
 * Önerilen tutar (Aşama 3.2). Fiyat dönemlerinden hesaplanan toplam ve döküm gösterilir; formdaki
 * tutar ASLA kendiliğinden değişmez. Misafire iletmek için hazır teklif metni (kopyala / WhatsApp)
 * sunulur; metinde misafir adı veya iletişim bilgisi yoktur.
 */
export function PriceQuote({
  propertyId,
  propertyName,
  checkIn,
  checkOut,
  currentTotal,
  currentCurrency,
  onUse,
}: Props) {
  const q = usePriceQuote(propertyId, checkIn, checkOut);
  const [copied, setCopied] = useState(false);
  if (q.state === "idle") return null;

  const shell = (children: React.ReactNode) => (
    <div
      data-testid="price-quote"
      aria-live="polite"
      className="flex flex-col gap-3 rounded-xl border border-border bg-mist/60 p-4"
    >
      <p className="text-sm font-semibold text-navy-900">Önerilen tutar (fiyat dönemlerinden)</p>
      {children}
    </div>
  );
  if (q.state === "loading") {
    return shell(<p className="text-sm text-muted-foreground">Hesaplanıyor…</p>);
  }
  const quote = q.quote;
  if (!quote) return null;
  const ratesLink = (
    <Link
      href={`/villalar/${propertyId}/fiyatlar`}
      className="font-medium text-turquoise-700 underline"
    >
      Fiyat dönemlerini düzenle
    </Link>
  );

  if (!quote.ok || quote.totalMinor === null || quote.currency === null) {
    const mismatch = quote.issues.some((i) => i.kind === "currency-mismatch");
    const tooLarge = quote.issues.some((i) => i.kind === "too-large");
    const summary = unpricedSummary(quote);
    return shell(
      <div className="flex flex-col gap-1 text-sm" data-testid="quote-unavailable">
        <p className="text-navy-900">
          {mismatch
            ? "Toplam hesaplanamadı: fiyat dönemleri farklı para birimlerinde."
            : tooLarge
              ? "Hesaplanan toplam izin verilen en yüksek tutarı aşıyor."
              : quote.segments.length === 0
                ? "Bu tarihler için fiyat dönemi tanımlı değil."
                : `Toplam hesaplanamadı: ${summary} için fiyat tanımlı değil.`}
        </p>
        {!mismatch && !tooLarge ? (
          <p className="text-muted-foreground">
            Fiyat bilgisi için iletişime geçilmesi gerekir. Tutarı elle girebilir ya da fiyatları
            tamamlayabilirsiniz: {ratesLink}.
          </p>
        ) : null}
      </div>,
    );
  }

  const c = quote.currency;
  const total = quote.totalMinor;
  const typed = parseAmount(currentTotal);
  const same =
    typed !== undefined &&
    !Number.isNaN(typed) &&
    toMinor(typed) === total &&
    currentCurrency === c;
  const message = quoteMessage(quote, propertyName) ?? "";

  return shell(
    <>
      <ul className="flex flex-col gap-1.5 text-sm" data-testid="quote-lines">
        {quote.segments.map((s) => (
          <li key={s.from} className="flex flex-wrap justify-between gap-x-3">
            <span className="text-navy-900">
              {formatStay(s.from, s.to)} · {s.nights} gece
              <span className="block text-muted-foreground">{segmentFormula(s, c)}</span>
            </span>
            <span className="font-medium text-navy-900 tabular-nums">
              {formatMoney(s.subtotalMinor ?? 0, c)}
            </span>
          </li>
        ))}
      </ul>
      <p className="flex justify-between border-t border-border pt-2 text-[15px] font-semibold text-navy-900">
        <span>Toplam · {quote.nights} gece</span>
        <span className="tabular-nums" data-testid="quote-total">
          {formatMoney(total, c)}
        </span>
      </p>
      {quote.minNights ? (
        <p
          data-testid="quote-min-nights"
          className="rounded-lg border border-amber-500/50 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Giriş tarihinin fiyat döneminde minimum konaklama {quote.minNights.required} gece; bu
          kayıt {quote.nights} gece. Bu bir uyarıdır, kaydı engellemez.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={same}
          onClick={() => onUse(minorToInput(total), c)}
        >
          Bu tutarı kullan
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            navigator.clipboard
              ?.writeText(message)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          Teklif metnini kopyala
        </Button>
        <a
          href={`https://wa.me/?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ size: "sm", variant: "secondary" })}
        >
          WhatsApp ile gönder
        </a>
        <span className="text-sm text-turquoise-700" role="status">
          {copied ? "Kopyalandı." : same ? "Formdaki tutar bununla aynı." : ""}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Tutar forma yalnız siz &quot;Bu tutarı kullan&quot; dediğinizde aktarılır; kayıtlı
        rezervasyon tutarları kendiliğinden değişmez.
      </p>
    </>,
  );
}
