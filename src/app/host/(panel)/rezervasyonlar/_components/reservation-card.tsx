import Link from "next/link";

import {
  type Currency,
  formatStay,
  RESERVATION_SOURCE_LABELS,
  type ReservationKind,
  type ReservationSource,
  type ReservationStatus,
} from "@/lib/reservation-meta";

import { Money, ReservationStatusBadge } from "./reservation-bits";

/** Liste kartı için gereken alanlar (telefon / e-posta gibi ayrıntılar gönderilmez). */
export type ReservationCardData = {
  id: string;
  kind: ReservationKind;
  status: ReservationStatus;
  source: ReservationSource | null;
  checkIn: string;
  checkOut: string;
  nights: number;
  guestName: string | null;
  adults: number | null;
  children: number | null;
  totalAmountMinor: number | null;
  balanceAmountMinor: number | null;
  currency: Currency | null;
  note: string | null;
  propertyName: string;
};

export const toCardData = (r: ReservationCardData): ReservationCardData => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  source: r.source,
  checkIn: r.checkIn,
  checkOut: r.checkOut,
  nights: r.nights,
  guestName: r.guestName,
  adults: r.adults,
  children: r.children,
  totalAmountMinor: r.totalAmountMinor,
  balanceAmountMinor: r.balanceAmountMinor,
  currency: r.currency,
  note: r.note,
  propertyName: r.propertyName,
});

export function ReservationCard({
  r,
  showProperty,
}: {
  r: ReservationCardData;
  showProperty: boolean;
}) {
  const isBlock = r.kind === "block";
  const guests =
    r.adults !== null ? `${r.adults} yetişkin${r.children ? `, ${r.children} çocuk` : ""}` : null;
  return (
    <Link
      href={`/rezervasyonlar/${r.id}`}
      data-testid="reservation-card"
      className="flex flex-col gap-3 rounded-2xl border border-border bg-white p-4 shadow-sm transition-colors hover:border-turquoise-500 focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-navy-900">
            {isBlock ? (r.note ? `Blok · ${r.note}` : "Kapalı tarihler") : r.guestName}
          </p>
          <p className="mt-0.5 text-sm text-navy-900">
            {formatStay(r.checkIn, r.checkOut)} · {r.nights} gece
          </p>
          {showProperty ? (
            <p className="mt-0.5 truncate text-sm text-muted-foreground">{r.propertyName}</p>
          ) : null}
        </div>
        <ReservationStatusBadge status={r.status} kind={r.kind} />
      </div>
      {isBlock ? null : (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>
            {guests}
            {r.source ? ` · ${RESERVATION_SOURCE_LABELS[r.source]}` : null}
          </span>
          {r.totalAmountMinor !== null ? (
            <span className="text-navy-900">
              <Money minor={r.totalAmountMinor} currency={r.currency} />
              {r.balanceAmountMinor ? (
                <span className="text-muted-foreground">
                  {" "}
                  · kalan <Money minor={r.balanceAmountMinor} currency={r.currency} />
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
      )}
    </Link>
  );
}
