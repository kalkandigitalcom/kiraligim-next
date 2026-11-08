"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { quoteMessage, quoteStay, segmentFormula, unpricedSummary } from "@/lib/pricing";
import { formatNights, formatPeriod } from "@/lib/rate-meta";
import { formatMoney, isIsoDate, nightsBetween } from "@/lib/reservation-meta";
import { cn } from "@/lib/utils";

import {
  SAMPLE_PERIODS,
  SAMPLE_PRESETS,
  SAMPLE_PROPERTY,
  SAMPLE_RANGE,
  SAMPLE_SEASON_LABELS,
} from "./sample";

const MAX_NIGHTS = 60;
const DAY = 86_400_000;
const RANGE_DAYS = nightsBetween(SAMPLE_RANGE.min, SAMPLE_RANGE.max);

/** Sayıyı yumuşakça değiştirir (hareket azaltma tercihinde doğrudan). */
function useTween(target: number, ms = 650) {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dur = reduce ? 0 : ms;
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = dur === 0 ? 1 : Math.min(1, (t - start) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      const v = Math.round(a + (target - a) * e);
      setValue(v);
      from.current = v;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/**
 * Canlı konaklama fiyatı hesaplayıcı. Paneldeki motorun aynısı (quoteStay) örnek fiyat
 * dönemleriyle tarayıcıda çalışır; sunucuya istek atmaz, hiçbir şey kaydetmez.
 */
export function PriceCalculator() {
  const [checkIn, setCheckIn] = useState<string>(SAMPLE_PRESETS[0].checkIn);
  const [checkOut, setCheckOut] = useState<string>(SAMPLE_PRESETS[0].checkOut);
  const [copied, setCopied] = useState(false);
  const markerRef = useRef<HTMLSpanElement>(null);

  const valid = isIsoDate(checkIn) && isIsoDate(checkOut);
  const nights = valid ? nightsBetween(checkIn, checkOut) : 0;
  const error = !valid
    ? "Giriş ve çıkış tarihlerini seçin."
    : nights <= 0
      ? "Çıkış tarihi giriş tarihinden sonra olmalı."
      : nights > MAX_NIGHTS
        ? `Bu örnekte en fazla ${MAX_NIGHTS} gece hesaplanır.`
        : null;

  const quote = useMemo(
    () => (error ? null : quoteStay(checkIn, checkOut, SAMPLE_PERIODS)),
    [checkIn, checkOut, error],
  );
  const message = quote ? quoteMessage(quote, SAMPLE_PROPERTY) : null;
  const total = useTween(quote?.totalMinor ?? 0);
  const shownNights = useTween(error ? 0 : nights, 400);
  const currency = "TRY" as const;

  // Seçili konaklamanın şerit üzerindeki konumu (CSSOM: CSP'ye tabi değil).
  useEffect(() => {
    const el = markerRef.current;
    if (!el) return;
    if (error) {
      el.dataset.hidden = "";
      return;
    }
    delete el.dataset.hidden;
    const start = Math.max(0, (Date.parse(checkIn) - Date.parse(SAMPLE_RANGE.min)) / DAY);
    const end = Math.min(RANGE_DAYS, (Date.parse(checkOut) - Date.parse(SAMPLE_RANGE.min)) / DAY);
    el.style.setProperty("--l", `${((start / RANGE_DAYS) * 100).toFixed(2)}%`);
    el.style.setProperty("--w", `${Math.max(0.6, ((end - start) / RANGE_DAYS) * 100).toFixed(2)}%`);
  }, [checkIn, checkOut, error]);

  const activePreset = SAMPLE_PRESETS.find((p) => p.checkIn === checkIn && p.checkOut === checkOut);

  const copy = async () => {
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const input =
    "h-12 w-full rounded-xl border border-white/15 bg-white/10 px-3.5 text-[15px] font-medium text-white [color-scheme:dark] focus-visible:border-turquoise-500 focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none";

  return (
    <div className="grid gap-6 lg:grid-cols-[1.05fr_1fr] lg:gap-8" data-testid="price-calculator">
      {/* Sol: giriş ve dönemler */}
      <div className="flex flex-col gap-6 rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur sm:p-7">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-turquoise-500">Örnek mülk (kurgusal)</p>
            <p className="text-xl font-bold text-white">{SAMPLE_PROPERTY}</p>
          </div>
          <span className="rounded-full border border-white/15 px-3 py-1 text-xs font-medium text-white/70">
            TRY · 4 dönem
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-white/80">
            Giriş tarihi
            <input
              type="date"
              className={input}
              value={checkIn}
              min={SAMPLE_RANGE.min}
              max={SAMPLE_RANGE.max}
              onChange={(e) => setCheckIn(e.target.value)}
              data-testid="calc-checkin"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-white/80">
            Çıkış tarihi
            <input
              type="date"
              className={input}
              value={checkOut}
              min={SAMPLE_RANGE.min}
              max={SAMPLE_RANGE.max}
              onChange={(e) => setCheckOut(e.target.value)}
              data-testid="calc-checkout"
            />
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold tracking-wide text-white/50 uppercase">
            Hazır örnekler
          </p>
          <div className="flex flex-wrap gap-2">
            {SAMPLE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => {
                  setCheckIn(p.checkIn);
                  setCheckOut(p.checkOut);
                }}
                aria-pressed={activePreset?.key === p.key}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none",
                  activePreset?.key === p.key
                    ? "border-turquoise-500 bg-turquoise-500 text-navy-950"
                    : "border-white/15 text-white/80 hover:border-white/40 hover:text-white",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Dönem şeridi ve seçili konaklama */}
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold tracking-wide text-white/50 uppercase">
            Fiyat dönemleri
          </p>
          <div className="relative pt-1">
            <div className="grid grid-cols-[61fr_30fr_62fr_61fr_30fr] gap-1">
              {SAMPLE_PERIODS.map((p, i) => (
                <span
                  key={p.id}
                  className={cn(
                    "h-3 rounded-full",
                    [
                      "bg-turquoise-500/30",
                      "bg-turquoise-500/55",
                      "bg-turquoise-500",
                      "bg-turquoise-500/40",
                    ][i],
                  )}
                />
              ))}
              <span className="h-3 rounded-full border border-dashed border-white/30" />
            </div>
            <span
              ref={markerRef}
              data-hidden=""
              aria-hidden="true"
              className="absolute top-0 left-[var(--l)] h-5 w-[var(--w)] rounded-md border-2 border-white bg-white/20 shadow-[0_0_0_4px_rgb(255_255_255/0.12)] transition-all duration-500 data-[hidden]:opacity-0"
            />
          </div>
          <ul className="mt-2 grid gap-2 text-[13px] sm:grid-cols-2">
            {SAMPLE_PERIODS.map((p) => (
              <li
                key={p.id}
                className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5"
              >
                <p className="font-semibold text-white">
                  {SAMPLE_SEASON_LABELS[p.id]}{" "}
                  <span className="font-normal text-white/50">· {formatPeriod(p)}</span>
                </p>
                <p className="mt-0.5 text-white/70 tabular-nums">
                  {formatMoney(p.nightlyAmountMinor ?? 0, p.currency)} gece ·{" "}
                  {formatMoney(p.weeklyAmountMinor ?? 0, p.currency)} hafta
                </p>
                <p className="text-white/50">
                  Temizlik {formatMoney(p.cleaningFeeMinor ?? 0, p.currency)} (
                  {p.cleaningFeeFreeNights} geceden kısa) · min. {p.minNights} gece
                </p>
              </li>
            ))}
            <li className="rounded-xl border border-dashed border-white/15 px-3 py-2.5 text-white/50">
              Kasım: fiyat tanımlı değil
            </li>
          </ul>
        </div>
      </div>

      {/* Sağ: döküm */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-5 rounded-3xl bg-white p-5 text-navy-900 shadow-2xl shadow-black/30 sm:p-7">
          <div className="flex items-end justify-between gap-4 border-b border-navy-900/10 pb-4">
            <div>
              <p className="text-sm font-medium text-navy-900/60">Konaklama</p>
              <p className="text-base font-semibold" data-testid="calc-stay">
                {error ? "—" : formatNights(checkIn, checkOut)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm font-medium text-navy-900/60">Gece</p>
              <p className="text-3xl font-extrabold tabular-nums" data-testid="calc-nights">
                {shownNights}
              </p>
            </div>
          </div>

          {error ? (
            <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">
              {error}
            </p>
          ) : quote && !quote.ok ? (
            <div
              className="rounded-xl border border-amber-500/50 bg-amber-50 px-4 py-3 text-sm text-amber-900"
              data-testid="calc-unpriced"
              role="status"
            >
              <p className="font-semibold">Toplam hesaplanmadı.</p>
              <p className="mt-1">
                Fiyatı tanımlı olmayan geceler: {unpricedSummary(quote)}. Panel, eksik bir gece
                varsa tahmini tutar göstermez.
              </p>
            </div>
          ) : quote ? (
            <ul className="flex flex-col gap-3 text-[15px]" data-testid="calc-lines">
              {quote.segments.map((s) => (
                <li key={s.from} className="flex justify-between gap-4">
                  <span>
                    <span className="font-medium">
                      {SAMPLE_SEASON_LABELS[s.periodId]} · {s.nights} gece
                    </span>
                    <span className="block text-sm text-navy-900/55">
                      {segmentFormula(s, currency)}
                    </span>
                    {s.weeks > 0 ? (
                      <span className="mt-1 inline-block rounded-md bg-turquoise-50 px-2 py-0.5 text-xs font-semibold text-turquoise-700">
                        {s.weeks} haftalık blok uygulandı
                      </span>
                    ) : null}
                  </span>
                  <span className="font-semibold tabular-nums">
                    {formatMoney(s.subtotalMinor ?? 0, currency)}
                  </span>
                </li>
              ))}
              <li className="flex justify-between gap-4" data-testid="calc-cleaning">
                <span>
                  <span className="font-medium">Temizlik ücreti</span>
                  <span className="block text-sm text-navy-900/55">
                    {quote.cleaningFee
                      ? `${quote.cleaningFee.freeFromNights} geceden kısa konaklamada, bir kez`
                      : `${SAMPLE_PERIODS.find((p) => p.startDate <= checkIn && checkIn < p.endDate)?.cleaningFeeFreeNights ?? 7} gece ve üzeri konaklamada alınmaz`}
                  </span>
                </span>
                <span className="font-semibold tabular-nums">
                  {quote.cleaningFee
                    ? formatMoney(quote.cleaningFee.amountMinor, currency)
                    : "Ücretsiz"}
                </span>
              </li>
            </ul>
          ) : null}

          {quote?.minNights ? (
            <p
              className="rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-900"
              data-testid="calc-min-nights"
            >
              Bu dönemde minimum konaklama {quote.minNights.required} gece. Panel bunu uyarı olarak
              gösterir; kararı siz verirsiniz.
            </p>
          ) : null}

          <div className="flex items-end justify-between gap-4 rounded-2xl bg-navy-900 px-5 py-4 text-white">
            <span className="text-sm font-medium text-white/70">Genel toplam</span>
            <span
              className="text-3xl font-extrabold tracking-tight tabular-nums sm:text-4xl"
              data-testid="calc-total"
              aria-hidden="true"
            >
              {quote?.ok ? formatMoney(total, currency) : "—"}
            </span>
            <span className="sr-only" aria-live="polite">
              {quote?.ok && quote.totalMinor !== null
                ? `Genel toplam ${formatMoney(quote.totalMinor, currency)}`
                : "Toplam hesaplanmadı"}
            </span>
          </div>
        </div>

        {message ? (
          <div className="flex flex-col gap-2 rounded-3xl border border-white/10 bg-white/5 p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-white">{"WhatsApp'a hazır teklif metni"}</p>
              <button
                type="button"
                onClick={copy}
                className="rounded-lg border border-white/20 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/10 focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
              >
                {copied ? "Kopyalandı" : "Metni kopyala"}
              </button>
            </div>
            <p
              className="max-h-44 overflow-y-auto rounded-xl rounded-tr-sm bg-[#d9fdd3] px-3.5 py-3 text-[13px] leading-relaxed whitespace-pre-line text-[#111b21]"
              data-testid="calc-message"
            >
              {message}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
