import { PROPERTY_STATUS_LABELS, type PropertyStatus } from "@/lib/property-meta";
import { cn } from "@/lib/utils";
import type { PropertyUsage } from "@/server/properties/service";

/** Aktif / pasif rozeti. */
export function StatusBadge({ status }: { status: PropertyStatus }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        status === "active"
          ? "bg-turquoise-50 text-turquoise-700"
          : "bg-muted text-muted-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          status === "active" ? "bg-turquoise-500" : "bg-muted-foreground/60",
        )}
      />
      {PROPERTY_STATUS_LABELS[status]}
    </span>
  );
}

/**
 * Paket kullanım göstergesi: "1 / 1 mülk" + dilimli çubuk. Aktif ve pasif tüm mülkler sayılır.
 * Satır içi stil kullanılmaz (CSP style-src nonce): limit ≤ 10 ise her mülk bir dilim, aksi
 * halde %10'luk dilimler.
 */
export function UsageMeter({ usage }: { usage: PropertyUsage }) {
  const segments = usage.limit > 0 && usage.limit <= 10 ? usage.limit : 10;
  const filled =
    usage.limit <= 0
      ? segments
      : usage.limit <= 10
        ? Math.min(usage.used, segments)
        : Math.min(segments, Math.ceil((usage.used / usage.limit) * 10));
  const full = usage.used >= usage.limit;
  return (
    <div className="flex min-w-48 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground">{usage.planName ?? "Paket"}</span>
        <span className="font-semibold text-navy-900">
          {usage.used} / {usage.limit} mülk
        </span>
      </div>
      <div
        role="meter"
        aria-label="Mülk kullanımı"
        aria-valuemin={0}
        aria-valuemax={Math.max(usage.limit, 0)}
        aria-valuenow={usage.used}
        aria-valuetext={`${usage.used} / ${usage.limit} mülk`}
        className="flex gap-1"
      >
        {Array.from({ length: Math.max(segments, 1) }, (_, i) => (
          <span
            key={i}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              i < filled ? (full ? "bg-navy-800" : "bg-turquoise-500") : "bg-border",
            )}
          />
        ))}
      </div>
    </div>
  );
}
