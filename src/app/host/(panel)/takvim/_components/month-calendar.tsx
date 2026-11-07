"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  type CalendarEntry,
  type CalendarWeek,
  dayActivity,
  dayLabel,
  entryTone,
  formatLongDay,
  WEEKDAYS,
} from "@/lib/calendar";
import { addDays, formatStay } from "@/lib/reservation-meta";
import { cn } from "@/lib/utils";

import { ReservationStatusBadge } from "../../rezervasyonlar/_components/reservation-bits";
import { DAY_COL, HALF_END, HALF_START, TONE_BAR } from "./calendar-styles";

type Props = {
  monthLabel: string;
  weeks: CalendarWeek[];
  /** Güvenli DTO: telefon, e-posta ve tutar içermez. */
  entries: CalendarEntry[];
  /** Ayın kayıt listesi (sunucuda üretilir), gün panelinin yanında gösterilir. */
  children?: React.ReactNode;
};

const KEY_STEP: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
};

/**
 * Aylık takvim ızgarası (salt okunur). Şeritler kaydın detayına götürür (masaüstü); güne
 * dokunmak/tıklamak gün panelini açar (mobilde asıl yol). Klavye: ok tuşları günler arasında,
 * Home/End hafta başı/sonu, Enter/Boşluk günü seçer. Seçim istemci durumudur; URL'ye yazılmaz.
 */
export function MonthCalendar({ monthLabel, weeks, entries, children }: Props) {
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
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
        data-testid="month-grid"
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
              return (
                <div
                  key={d.date}
                  role="gridcell"
                  aria-selected={isSelected}
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
                    aria-label={dayLabel(d, entries)}
                    aria-current={d.isToday ? "date" : undefined}
                    onClick={() => {
                      setSelected(d.date);
                      setFocusDate(d.date);
                    }}
                    onKeyDown={onKeyDown(d.date, i)}
                    className={cn(
                      "flex h-full min-h-14 w-full items-start p-1 text-left transition-colors focus-visible:ring-3 focus-visible:ring-turquoise-500/50 focus-visible:outline-none focus-visible:ring-inset sm:min-h-24 sm:p-1.5",
                      isSelected ? "bg-turquoise-50" : d.inMonth ? "hover:bg-mist" : "bg-mist/70",
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
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <DayPanel date={selected} entries={entries} />
        {children}
      </div>
    </div>
  );
}

function DayPanel({ date, entries }: { date: string | null; entries: CalendarEntry[] }) {
  const act = date ? dayActivity(date, entries) : null;
  const groups = act
    ? ([
        ["Çıkış", act.checkOuts],
        ["Giriş", act.checkIns],
        ["Konaklama", act.stays],
      ] as const)
    : [];
  const empty = act && groups.every(([, list]) => list.length === 0);
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
          </div>
        )}
      </div>
    </section>
  );
}
