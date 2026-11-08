"use client";

import { useState } from "react";

import { formatLongDay, formatMonth, monthGrid, shiftMonth, WEEKDAYS } from "@/lib/calendar";
import { dayView, stayMonthRange } from "@/lib/public-stay";
import { formatDay } from "@/lib/reservation-meta";
import { cn } from "@/lib/utils";

import { useStay } from "./stay-context";

/**
 * Müsaitlik takvimi (F2c): masaüstünde iki ay, mobilde bir ay. Dolu geceler (beklemede, onaylı ve
 * bloklar ayrımsız) "Dolu" görünür ve giriş için seçilemez. Giriş seçiliyken bir sonraki dolu
 * aralığın ilk günü çıkış olarak seçilebilir (önceki misafir o sabah çıkar).
 */
export function AvailabilityCalendar({
  compact = false,
  onDayPicked,
}: {
  /**
   * Rezervasyon kartındaki tarih seçici: tek ay, açıklama yok. Aynı seçim durumunu (StayProvider)
   * kullanır; burada seçilen tarih sayfadaki büyük takvimde de görünür (ve tersi).
   */
  compact?: boolean;
  /** Gün seçildikten sonra (seçim güncellendikten sonra değil, aynı tıklamada) çağrılır. */
  onDayPicked?: (date: string) => void;
} = {}) {
  const { window: w, busy, selection, evaluation, pick, clear } = useStay();
  const range = stayMonthRange(w);
  const [month, setMonth] = useState(() => {
    const m = selection.checkIn ? selection.checkIn.slice(0, 7) : range.min;
    return m < range.min ? range.min : m > range.max ? range.max : m;
  });
  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const canPrev = prev >= range.min;
  const canNext = next <= range.max;

  const hint =
    evaluation.state === "checkout"
      ? `Çıkış tarihini seçin (en geç ${formatDay(evaluation.latest)}).`
      : selection.checkIn && selection.checkOut
        ? "Tarihleri değiştirmek için yeni bir giriş günü seçin."
        : "Giriş tarihini seçin. Aynı gün giriş yapılabilir.";

  return (
    <div
      className={cn("flex flex-col", compact ? "gap-3" : "gap-4")}
      data-testid={compact ? "booking-calendar" : "villa-calendar"}
    >
      <div className="flex items-center justify-between gap-3">
        <p
          className={cn("text-navy-900/75", compact ? "text-sm" : "text-[15px]")}
          aria-live="polite"
          data-testid={compact ? "booking-calendar-hint" : "calendar-hint"}
        >
          {hint}
        </p>
        {selection.checkIn && (
          <button
            type="button"
            onClick={clear}
            className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold text-turquoise-700 hover:bg-turquoise-50 focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
          >
            Temizle
          </button>
        )}
      </div>

      <div
        className={cn(
          "relative border border-border",
          compact ? "rounded-2xl p-2" : "rounded-3xl p-3 sm:p-5",
        )}
      >
        <div
          className={cn(
            "absolute flex justify-between",
            compact ? "top-2 right-2 left-2" : "top-3 right-3 left-3 sm:top-5 sm:right-5 sm:left-5",
          )}
        >
          <NavButton dir="prev" disabled={!canPrev} onClick={() => setMonth(prev)} />
          <NavButton dir="next" disabled={!canNext} onClick={() => setMonth(next)} />
        </div>
        {compact ? (
          renderMonth(month)
        ) : (
          <div className="grid gap-8 md:grid-cols-2">
            {renderMonth(month)}
            {/* Masaüstünde ikinci ay; ufkun ötesindeyse gösterilmez. */}
            <div className="hidden md:block">{next <= range.max ? renderMonth(next) : null}</div>
          </div>
        )}
      </div>
      {compact ? null : (
        <>
          <ul
            className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-navy-900/70"
            aria-label="Takvim açıklaması"
          >
            <li className="flex items-center gap-2">
              <span className="size-4 rounded border border-border bg-white" aria-hidden="true" />
              Müsait
            </li>
            <li className="flex items-center gap-2">
              <span className="size-4 rounded cal-block" aria-hidden="true" />
              Dolu
            </li>
            <li className="flex items-center gap-2">
              <span className="size-4 rounded bg-navy-900" aria-hidden="true" />
              Seçili giriş / çıkış
            </li>
          </ul>
          <p className="sr-only">
            Bugün: {formatDay(w.today)}. Takvimde{" "}
            {busy.length > 0 ? "dolu geceler işaretlidir" : "dolu gece yok"}.
          </p>
        </>
      )}
    </div>
  );

  function renderMonth(key: string) {
    const grid = monthGrid(key, w.today);
    return (
      <div>
        <h3 className="mb-3 text-center text-base font-bold capitalize">{formatMonth(key)}</h3>
        <table className="w-full table-fixed border-collapse text-center">
          <caption className="sr-only">{formatMonth(key)} müsaitlik</caption>
          <thead>
            <tr>
              {WEEKDAYS.map((d) => (
                <th
                  key={d.short}
                  scope="col"
                  abbr={d.long}
                  className="pb-2 text-xs font-semibold text-navy-900/50"
                >
                  {d.short}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.weeks.map((wk) => (
              <tr key={wk.start}>
                {wk.days.map((d) => (
                  <td key={d.date} className="p-0.5">
                    {d.inMonth ? renderDay(d.date, d.day) : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function renderDay(date: string, day: number) {
    const v = dayView(date, selection, busy, w);
    const status = v.outside
      ? "seçilemez"
      : v.checkoutOnly
        ? "dolu, yalnız çıkış için uygun"
        : v.busy
          ? "dolu"
          : v.selectable
            ? "müsait"
            : "seçilemez";
    const roleLabel =
      v.role === "checkin"
        ? ", giriş günü"
        : v.role === "checkout"
          ? ", çıkış günü"
          : v.role === "inside"
            ? ", seçili"
            : "";
    return (
      <button
        type="button"
        // Seçili giriş/çıkış günü (dolu aralığın başı olsa da) odaklanabilir ve okunur kalır.
        disabled={!v.selectable && v.role === null}
        onClick={() => {
          pick(date);
          onDayPicked?.(date);
        }}
        aria-label={`${formatLongDay(date)}, ${status}${roleLabel}`}
        aria-pressed={v.role === "checkin" || v.role === "checkout"}
        data-date={date}
        data-state={
          v.role ?? (v.busy ? "busy" : v.outside ? "outside" : v.selectable ? "free" : "closed")
        }
        className={cn(
          "relative flex aspect-square w-full items-center justify-center rounded-lg font-medium transition-colors",
          compact ? "text-sm" : "text-[15px]",
          "focus-visible:ring-3 focus-visible:ring-turquoise-500/60 focus-visible:outline-none",
          v.role === "checkin" || v.role === "checkout"
            ? "bg-navy-900 text-white"
            : v.role === "inside"
              ? "bg-turquoise-50 text-navy-900"
              : v.busy
                ? cn("cal-block text-navy-900/45", !v.checkoutOnly && "line-through")
                : v.outside || !v.selectable
                  ? "text-navy-900/25"
                  : "text-navy-900 hover:bg-turquoise-50",
          v.checkoutOnly &&
            v.role === null &&
            "ring-1 ring-turquoise-500/50 ring-inset hover:bg-turquoise-50",
          date === w.today &&
            v.role === null &&
            "font-bold underline decoration-turquoise-500 underline-offset-4",
        )}
      >
        {day}
      </button>
    );
  }
}

function NavButton({
  dir,
  disabled,
  onClick,
}: {
  dir: "prev" | "next";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === "prev" ? "Önceki ay" : "Sonraki ay"}
      className="inline-flex size-9 items-center justify-center rounded-full text-navy-900 hover:bg-mist focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none disabled:opacity-30"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-5 fill-none stroke-current stroke-2"
      >
        <path
          d={dir === "prev" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
