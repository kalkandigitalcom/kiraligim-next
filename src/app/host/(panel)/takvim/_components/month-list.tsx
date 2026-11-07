import Link from "next/link";

import { type CalendarEntry, type CalendarTone, entryTone } from "@/lib/calendar";
import { formatStay } from "@/lib/reservation-meta";
import { cn } from "@/lib/utils";

import { ReservationStatusBadge } from "../../rezervasyonlar/_components/reservation-bits";
import { TONE_BAR, TONE_LABEL } from "./calendar-styles";

/** Ayın kayıtları, girişe göre (ekran okuyucu ve mobil için ızgaranın metin karşılığı). */
export function MonthList({ title, entries }: { title: string; entries: CalendarEntry[] }) {
  return (
    <section
      aria-labelledby="month-list-title"
      data-testid="month-list"
      className="rounded-2xl border border-border bg-white p-4 shadow-sm sm:p-5"
    >
      <h2 id="month-list-title" className="font-semibold text-navy-900">
        {title} <span className="font-normal text-muted-foreground">({entries.length})</span>
      </h2>
      {entries.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">Bu ay kayıt yok.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {entries.map((e) => (
            <li key={e.id}>
              <Link
                href={`/rezervasyonlar/${e.id}`}
                prefetch={false}
                data-testid="month-entry"
                className="flex items-start justify-between gap-3 rounded-xl border border-border px-3 py-2.5 transition-colors hover:border-turquoise-500 focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
              >
                <span className="flex min-w-0 items-start gap-2.5">
                  <span
                    aria-hidden
                    className={cn("mt-1.5 h-2.5 w-4 shrink-0 rounded-sm", TONE_BAR[entryTone(e)])}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-navy-900">{e.label}</span>
                    <span className="block text-sm text-muted-foreground">
                      {formatStay(e.checkIn, e.checkOut)} · {e.nights} gece
                    </span>
                  </span>
                </span>
                <ReservationStatusBadge status={e.status} kind={e.kind} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const LEGEND: CalendarTone[] = ["confirmed", "pending", "block"];

export function CalendarLegend() {
  return (
    <div className="flex flex-col gap-1.5 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <ul aria-label="Renkler" className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {LEGEND.map((t) => (
          <li key={t} className="flex items-center gap-1.5">
            <span aria-hidden className={cn("h-3 w-5 rounded-sm", TONE_BAR[t])} />
            {TONE_LABEL[t]}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-3 rounded-full bg-turquoise-700" />
          Bugün
        </li>
      </ul>
      <p className="text-xs">
        Şerit giriş günü öğleden sonra başlar, çıkış günü öğleden önce biter.
      </p>
    </div>
  );
}
