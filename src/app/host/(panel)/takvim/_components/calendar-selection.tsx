"use client";

import Link from "next/link";
import { createContext, useContext, useMemo, useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import {
  type CalendarEntry,
  createHref,
  EMPTY_SELECTION,
  formatLongDay,
  type RangeSelection,
  SELECTION_ERRORS,
  type SelectionError,
  type SelectionRules,
  selectDay,
  WEEKDAYS,
  weekdayIndex,
} from "@/lib/calendar";
import { formatStay, nightsBetween } from "@/lib/reservation-meta";
import { cn } from "@/lib/utils";

/**
 * Takvimden yeni kayıt için tarih aralığı seçimi (3.0c-3). Yalnız Owner/Manager ve aktif mülkte
 * açıktır (enabled, sunucuda belirlenir). Seçim tamamlanınca mevcut forma ön doldurmalı bağlantı
 * verilir; kayıt mantığı burada değil, formun action → servis → veritabanı zincirindedir.
 * Seçim istemci durumudur; yalnız ay değiştirirken bekleyen giriş günü ?baslangic ile taşınır.
 */
type SelectionContext = {
  enabled: boolean;
  selection: RangeSelection;
  error: SelectionError | null;
  /** Fareyle gezinirken çıkış önizlemesi (dokunmatikte yok). */
  preview: string | null;
  pick: (date: string) => void;
  setPreview: (date: string | null) => void;
  clear: () => void;
};

const Ctx = createContext<SelectionContext>({
  enabled: false,
  selection: EMPTY_SELECTION,
  error: null,
  preview: null,
  pick: () => {},
  setPreview: () => {},
  clear: () => {},
});

export const useCalendarSelection = () => useContext(Ctx);

type ProviderProps = {
  enabled: boolean;
  /** Giriş tarihi penceresi (checkInWindow). */
  min: string;
  max: string;
  /** Dolu aralıklar: Kiraligim kayıtları ve harici takvim (iCal) dolulukları. */
  entries: readonly Pick<CalendarEntry, "id" | "checkIn" | "checkOut">[];
  /** Önceki/sonraki aydan taşınan bekleyen giriş günü (sunucuda doğrulanmış). */
  initialStart: string | null;
  children: React.ReactNode;
};

export function CalendarSelectionProvider({
  enabled,
  min,
  max,
  entries,
  initialStart,
  children,
}: ProviderProps) {
  const rules: SelectionRules = useMemo(() => ({ min, max, entries }), [min, max, entries]);
  const [selection, setSelection] = useState<RangeSelection>(() =>
    enabled && initialStart
      ? selectDay(EMPTY_SELECTION, initialStart, rules).selection
      : EMPTY_SELECTION,
  );
  const [error, setError] = useState<SelectionError | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const value: SelectionContext = {
    enabled,
    selection,
    error,
    preview,
    pick: (date) => {
      if (!enabled) return;
      const r = selectDay(selection, date, rules);
      setSelection(r.selection);
      setError(r.error ?? null);
    },
    setPreview: (date) => setPreview(enabled ? date : null),
    clear: () => {
      setSelection(EMPTY_SELECTION);
      setError(null);
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const SELECTION_HINT_ID = "calendar-selection-hint";

/**
 * Seçim durumu ve işlemler. Boşken kısa bir ipucu; giriş seçilince ızgaranın altına yapışan
 * (sticky) çubuk: tarihler, gece sayısı, Rezervasyon oluştur / Blok oluştur / Temizle.
 */
export function SelectionBar({ propertyId }: { propertyId: string }) {
  const { enabled, selection, error, clear } = useCalendarSelection();
  if (!enabled) return null;
  const { start, end } = selection;
  const message = error ? SELECTION_ERRORS[error] : null;

  if (!start) {
    return (
      <div className="flex flex-col gap-1">
        <p id={SELECTION_HINT_ID} className="text-sm text-muted-foreground">
          Yeni rezervasyon veya blok için takvimde önce giriş gününü, sonra çıkış gününü seçin.
        </p>
        <p role="status" className="text-sm font-medium text-destructive empty:hidden">
          {message}
        </p>
      </div>
    );
  }

  const nights = end ? nightsBetween(start, end) : null;
  return (
    <div
      data-testid="selection-bar"
      className="sticky bottom-3 z-20 flex flex-col gap-3 rounded-2xl border border-navy-900/15 bg-white p-3 shadow-lg sm:flex-row sm:items-center sm:justify-between sm:p-4"
    >
      <div className="min-w-0" aria-live="polite">
        {end ? (
          <>
            <p className="font-semibold text-navy-900" data-testid="selection-range">
              {formatStay(start, end)}
            </p>
            <p className="text-sm text-muted-foreground">
              <span data-testid="selection-nights">{nights} gece</span> ·{" "}
              {WEEKDAYS[weekdayIndex(start)]!.long} → {WEEKDAYS[weekdayIndex(end)]!.long}
            </p>
          </>
        ) : (
          <>
            <p className="font-semibold text-navy-900" data-testid="selection-range">
              Giriş: {formatLongDay(start)}
            </p>
            <p className="text-sm text-muted-foreground">Şimdi çıkış gününü seçin.</p>
          </>
        )}
        <p role="status" className="mt-1 text-sm font-medium text-destructive empty:hidden">
          {message}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {end ? (
          <>
            <Link
              href={createHref("reservation", propertyId, start, end)}
              className={buttonVariants({ size: "sm", className: "flex-1 sm:flex-none" })}
            >
              Rezervasyon oluştur
            </Link>
            <Link
              href={createHref("block", propertyId, start, end)}
              className={buttonVariants({
                size: "sm",
                variant: "secondary",
                className: "flex-1 sm:flex-none",
              })}
            >
              Blok oluştur
            </Link>
          </>
        ) : null}
        <button
          type="button"
          onClick={clear}
          className={cn(
            buttonVariants({ size: "sm", variant: "secondary" }),
            end ? "flex-1 sm:flex-none" : "",
          )}
        >
          {end ? "Temizle" : "Vazgeç"}
        </button>
      </div>
    </div>
  );
}
