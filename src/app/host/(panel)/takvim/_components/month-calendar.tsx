"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  type CalendarEntry,
  type CalendarExternal,
  type CalendarWeek,
  dayActivity,
  type ExternalPiece,
  dayLabel,
  entryTone,
  formatLongDay,
  selectionRole,
  WEEKDAYS,
} from "@/lib/calendar";
import { formatSyncTime, ICAL_SOURCE_STATUS_LABELS } from "@/lib/ical-meta";
import { addDays, formatStay, nightsBetween } from "@/lib/reservation-meta";
import { cn } from "@/lib/utils";

import { ReservationStatusBadge } from "../../rezervasyonlar/_components/reservation-bits";
import { SELECTION_HINT_ID, SelectionBar, useCalendarSelection } from "./calendar-selection";
import {
  DAY_COL,
  EXTERNAL_BAR,
  EXTERNAL_LABEL,
  HALF_END,
  HALF_START,
  TONE_BAR,
} from "./calendar-styles";

type Props = {
  monthLabel: string;
  propertyId: string;
  weeks: CalendarWeek[];
  /** Harici takvim (iCal) şeritleri: birleşik aralığın kaynak parçaları, rezervasyon hattının altında (3.1). */
  externalWeeks: CalendarWeek[];
  /** Güvenli DTO: telefon, e-posta ve tutar içermez. */
  entries: CalendarEntry[];
  /** Harici dolulukların kendisi (gün paneli ayrıntısı için) ve şerit parçaları. */
  externals: CalendarExternal[];
  pieces: ExternalPiece[];
  /** Ayın kayıt listesi (sunucuda üretilir), gün panelinin yanında gösterilir. */
  children?: React.ReactNode;
};

const KEY_STEP: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
};

const ROLE_LABEL = {
  start: "seçili giriş günü",
  end: "seçili çıkış günü",
  inside: "seçili aralıkta",
};

/** Seçim rolüne göre hücre zemini: giriş/çıkış yarım gün (şerit modeliyle aynı), ara günler tam. */
const ROLE_BG = {
  start: "bg-linear-to-r from-transparent from-50% to-turquoise-500/25 to-50%",
  end: "bg-linear-to-r from-turquoise-500/25 from-50% to-transparent to-50%",
  inside: "bg-turquoise-500/25",
  preview: "bg-turquoise-500/10",
} as const;

/**
 * Aylık takvim ızgarası. Şeritler kaydın detayına götürür (masaüstü); güne dokunmak/tıklamak gün
 * panelini açar (mobilde asıl yol). Owner/Manager ve aktif mülkte aynı tıklama aralık seçimini de
 * yürütür: birinci tıklama giriş, ikinci tıklama çıkış (calendar-selection.tsx). Klavye: ok tuşları
 * günler arasında, Home/End hafta başı/sonu, Enter/Boşluk günü seçer, Esc seçimi temizler.
 */
export function MonthCalendar({
  monthLabel,
  propertyId,
  weeks,
  externalWeeks,
  entries,
  externals,
  pieces,
  children,
}: Props) {
  const sel = useCalendarSelection();
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const pieceById = useMemo(() => new Map(pieces.map((x) => [x.id, x])), [pieces]);
  const extSegments = useMemo(
    () => new Map(externalWeeks.map((w) => [w.start, w.segments])),
    [externalWeeks],
  );
  const days = weeks.flatMap((w) => w.days);
  const first = days[0]!.date;
  const end = addDays(days.at(-1)!.date, 1);
  const initial = days.find((d) => d.isToday && d.inMonth)?.date ?? null;

  const [selected, setSelected] = useState<string | null>(initial);
  const [focusDate, setFocusDate] = useState(initial ?? days.find((d) => d.inMonth)!.date);
  const gridRef = useRef<HTMLDivElement>(null);
  const moved = useRef(false);

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focusDate}"]`)?.focus();
  }, [focusDate]);

  const onKeyDown = (date: string, weekday: number) => (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && sel.selection.start) {
      e.preventDefault();
      sel.clear();
      return;
    }
    let step = KEY_STEP[e.key];
    if (e.key === "Home") step = -weekday;
    if (e.key === "End") step = 6 - weekday;
    if (step === undefined) return;
    e.preventDefault();
    const next = addDays(date, step);
    if (next < first || next >= end || next === date) return;
    moved.current = true;
    setFocusDate(next);
  };

  return (
    <div className="flex flex-col gap-6">
      <div
        ref={gridRef}
        role="grid"
        aria-label={`${monthLabel} takvimi`}
        aria-describedby={sel.enabled ? SELECTION_HINT_ID : undefined}
        aria-multiselectable={sel.enabled || undefined}
        data-testid="month-grid"
        data-selecting={sel.selection.start && !sel.selection.end ? "" : undefined}
        onPointerLeave={() => sel.setPreview(null)}
        className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm"
      >
        <div role="row" className="grid grid-cols-7 bg-mist/70">
          {WEEKDAYS.map((w) => (
            <div
              key={w.short}
              role="columnheader"
              aria-label={w.long}
              className="py-2 text-center text-xs font-semibold text-muted-foreground"
            >
              {w.short}
            </div>
          ))}
        </div>
        {weeks.map((w) => (
          <div
            key={w.start}
            role="row"
            className="grid grid-cols-14 grid-rows-[1.75rem_1fr] border-t border-border sm:grid-rows-[2.25rem_1fr]"
          >
            {w.days.map((d, i) => {
              const isSelected = d.date === selected;
              const role = selectionRole(d.date, sel.selection);
              const { start, end } = sel.selection;
              const previewing =
                !role && start && !end && sel.preview && d.date > start && d.date <= sel.preview;
              return (
                <div
                  key={d.date}
                  role="gridcell"
                  aria-selected={sel.enabled ? role !== null : isSelected}
                  data-selection={role ?? undefined}
                  className={cn(
                    DAY_COL[i],
                    "col-span-2 row-span-2 row-start-1 min-w-0",
                    i > 0 && "border-l border-border",
                  )}
                >
                  <button
                    type="button"
                    data-date={d.date}
                    tabIndex={d.date === focusDate ? 0 : -1}
                    aria-label={`${dayLabel(d, entries, externals)}${role ? `; ${ROLE_LABEL[role]}` : ""}`}
                    aria-current={d.isToday ? "date" : undefined}
                    onClick={() => {
                      setSelected(d.date);
                      setFocusDate(d.date);
                      sel.pick(d.date);
                    }}
                    onPointerEnter={(e) => {
                      if (e.pointerType === "mouse") sel.setPreview(d.date);
                    }}
                    onKeyDown={onKeyDown(d.date, i)}
                    className={cn(
                      "flex h-full min-h-14 w-full items-start p-1 text-left transition-colors focus-visible:ring-3 focus-visible:ring-turquoise-500/50 focus-visible:outline-none focus-visible:ring-inset sm:min-h-24 sm:p-1.5",
                      role
                        ? ROLE_BG[role]
                        : previewing
                          ? ROLE_BG.preview
                          : d.inMonth
                            ? "hover:bg-mist"
                            : "bg-mist/70",
                      (role === "start" || role === "end") && "ring-2 ring-navy-900/70 ring-inset",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums sm:size-7 sm:text-sm",
                        d.isToday
                          ? "bg-turquoise-700 text-white"
                          : d.inMonth
                            ? "text-navy-900"
                            : "text-muted-foreground",
                        isSelected && !d.isToday && "ring-2 ring-turquoise-500",
                      )}
                    >
                      {d.day}
                    </span>
                    {role === "start" || role === "end" ? (
                      <span
                        aria-hidden
                        className="ml-auto hidden rounded-full bg-navy-900 px-1.5 py-0.5 text-[10px] font-semibold text-white sm:inline"
                      >
                        {role === "start" ? "Giriş" : "Çıkış"}
                      </span>
                    ) : null}
                  </button>
                </div>
              );
            })}
            {w.segments.map((s) => {
              const e = byId.get(s.entryId);
              if (!e) return null;
              const tone = entryTone(e);
              return (
                <Link
                  key={`${w.start}:${s.entryId}`}
                  href={`/rezervasyonlar/${e.id}`}
                  prefetch={false}
                  // Klavye ve ekran okuyucu yolu gün düğmeleri + gün paneli; şerit fare kısayoludur.
                  aria-hidden
                  tabIndex={-1}
                  title={`${e.label} · ${formatStay(e.checkIn, e.checkOut)}`}
                  data-entry={e.id}
                  data-tone={tone}
                  className={cn(
                    HALF_START[s.startHalf],
                    HALF_END[s.endHalf],
                    "z-10 row-start-2 mx-px flex h-2 min-w-0 items-center self-start overflow-hidden text-xs font-semibold max-sm:pointer-events-none sm:h-6 sm:px-1.5",
                    TONE_BAR[tone],
                    s.startsHere && "rounded-l-full sm:rounded-l-md",
                    s.endsHere && "rounded-r-full sm:rounded-r-md",
                  )}
                >
                  {s.endHalf - s.startHalf >= 2 ? (
                    <span className="hidden truncate sm:inline">{e.label}</span>
                  ) : null}
                </Link>
              );
            })}
            {(extSegments.get(w.start) ?? []).map((s) => {
              const x = pieceById.get(s.entryId);
              if (!x) return null;
              const names = x.names.join(", ");
              return (
                // Harici doluluk bağlantı değildir: tıklama alttaki güne geçer, gün paneli ayrıntıyı gösterir.
                <div
                  key={`${w.start}:${s.entryId}`}
                  aria-hidden
                  title={`${EXTERNAL_LABEL}: ${names} · ${formatStay(x.checkIn, x.checkOut)}`}
                  data-external={x.id}
                  data-tone="external"
                  className={cn(
                    HALF_START[s.startHalf],
                    HALF_END[s.endHalf],
                    "pointer-events-none z-10 row-start-2 mx-px mt-3 flex h-2 min-w-0 items-center self-start overflow-hidden text-[11px] font-semibold sm:mt-7 sm:h-5 sm:px-1.5",
                    EXTERNAL_BAR,
                    // Parçalar bitişik durur; köşe yalnız birleşik aralığın başında/sonunda yuvarlanır.
                    x.startsSpan && s.startsHere && "rounded-l-full sm:rounded-l-md",
                    x.endsSpan && s.endsHere && "rounded-r-full sm:rounded-r-md",
                  )}
                >
                  {s.endHalf - s.startHalf >= 2 ? (
                    <span className="hidden truncate sm:inline">{names}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <SelectionBar propertyId={propertyId} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <DayPanel date={selected} entries={entries} externals={externals} />
        {children}
      </div>
    </div>
  );
}

function DayPanel({
  date,
  entries,
  externals,
}: {
  date: string | null;
  entries: CalendarEntry[];
  externals: CalendarExternal[];
}) {
  const act = date ? dayActivity(date, entries) : null;
  const ext = date ? dayActivity(date, externals) : null;
  const extList = ext ? [...ext.checkOuts, ...ext.checkIns, ...ext.stays] : [];
  const groups = act
    ? ([
        ["Çıkış", act.checkOuts],
        ["Giriş", act.checkIns],
        ["Konaklama", act.stays],
      ] as const)
    : [];
  const empty = act && groups.every(([, list]) => list.length === 0) && extList.length === 0;
  return (
    <section
      aria-labelledby="day-panel-title"
      data-testid="day-panel"
      className="rounded-2xl border border-border bg-white p-4 shadow-sm sm:p-5"
    >
      <div aria-live="polite">
        <h2 id="day-panel-title" className="font-semibold text-navy-900">
          {date ? formatLongDay(date) : "Gün ayrıntısı"}
        </h2>
        {!date ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Ayrıntıları görmek için takvimden bir gün seçin.
          </p>
        ) : empty ? (
          <p className="mt-1 text-sm text-muted-foreground">Bu gün boş.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-4">
            {groups.map(([title, list]) =>
              list.length ? (
                <div key={title}>
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    {title}
                  </h3>
                  <ul className="mt-1.5 flex flex-col gap-2">
                    {list.map((e) => (
                      <li key={e.id}>
                        <Link
                          href={`/rezervasyonlar/${e.id}`}
                          prefetch={false}
                          data-testid="day-entry"
                          className="flex items-start justify-between gap-3 rounded-xl border border-border px-3 py-2.5 transition-colors hover:border-turquoise-500 focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-navy-900">
                              {e.label}
                            </span>
                            <span className="block text-sm text-muted-foreground">
                              {formatStay(e.checkIn, e.checkOut)} · {e.nights} gece
                            </span>
                          </span>
                          <ReservationStatusBadge status={e.status} kind={e.kind} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}
            {extList.length ? (
              <div data-testid="day-external">
                <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {EXTERNAL_LABEL}
                </h3>
                <ul className="mt-1.5 flex flex-col gap-2">
                  {extList.map((e) => (
                    <li
                      key={e.id}
                      data-testid="day-external-entry"
                      className="flex items-start gap-2.5 rounded-xl border border-violet-200 bg-violet-50/60 px-3 py-2.5"
                    >
                      <span
                        aria-hidden
                        className={cn("mt-1.5 h-2.5 w-4 shrink-0 rounded-sm", EXTERNAL_BAR)}
                      />
                      <span className="min-w-0 text-sm">
                        <span className="block truncate font-medium text-navy-900">
                          {e.sourceName}
                        </span>
                        <span className="block text-muted-foreground">
                          {formatStay(e.checkIn, e.checkOut)} ·{" "}
                          {nightsBetween(e.checkIn, e.checkOut)} gece
                        </span>
                        <span className="block text-muted-foreground">
                          Son başarılı senkron: {formatSyncTime(e.lastSuccessAt)}
                        </span>
                        <span
                          className={cn(
                            "block",
                            e.sourceStatus === "error" ? "text-red-700" : "text-muted-foreground",
                          )}
                        >
                          Kaynak durumu: {ICAL_SOURCE_STATUS_LABELS[e.sourceStatus]}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
