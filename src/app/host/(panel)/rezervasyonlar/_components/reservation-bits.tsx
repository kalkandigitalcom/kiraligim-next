import {
  type Currency,
  formatMoney,
  RESERVATION_KIND_LABELS,
  RESERVATION_STATUS_LABELS,
  type ReservationKind,
  type ReservationStatus,
} from "@/lib/reservation-meta";
import { cn } from "@/lib/utils";

type BadgeKey = ReservationStatus | "block";

const BADGE: Record<BadgeKey, { box: string; dot: string; label: string }> = {
  confirmed: {
    box: "bg-turquoise-50 text-turquoise-700",
    dot: "bg-turquoise-500",
    label: RESERVATION_STATUS_LABELS.confirmed,
  },
  pending: {
    box: "bg-amber-50 text-amber-800",
    dot: "bg-amber-500",
    label: RESERVATION_STATUS_LABELS.pending,
  },
  cancelled: {
    box: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/60",
    label: RESERVATION_STATUS_LABELS.cancelled,
  },
  block: {
    box: "bg-navy-900/5 text-navy-900",
    dot: "bg-navy-900/50",
    label: RESERVATION_KIND_LABELS.block,
  },
};

/** Durum rozeti: Onaylı / Beklemede / İptal; etkin blok için "Blok". */
export function ReservationStatusBadge({
  status,
  kind,
}: {
  status: ReservationStatus;
  kind: ReservationKind;
}) {
  const b = BADGE[kind === "block" && status !== "cancelled" ? "block" : status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        b.box,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", b.dot)} />
      {b.label}
    </span>
  );
}

export function Money({ minor, currency }: { minor: number | null; currency: Currency | null }) {
  if (minor === null || currency === null) return <span className="text-muted-foreground">—</span>;
  return <span className="tabular-nums">{formatMoney(minor, currency)}</span>;
}
