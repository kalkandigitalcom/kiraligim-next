import { segmentFormula, type Quote } from "@/lib/pricing";
import { formatNights, formatPeriod, type RatePeriod } from "@/lib/rate-meta";
import { formatMoney } from "@/lib/reservation-meta";
import { cn } from "@/lib/utils";

import { DemoPhoto } from "./frames";
import { SAMPLE_SEASON_LABELS } from "./sample";

/*
 * Ürün arayüzünden birebir alınmış sınıflarla kurulan, hareketli tanıtım parçaları. Veriler
 * kurgusaldır; tutarlar quoteStay ile hesaplanır. Konumlar sabit sınıf tablolarındandır (CSP).
 */

const START = [
  "col-start-1",
  "col-start-2",
  "col-start-3",
  "col-start-4",
  "col-start-5",
  "col-start-6",
  "col-start-7",
  "col-start-8",
  "col-start-9",
  "col-start-10",
  "col-start-11",
  "col-start-12",
  "col-start-13",
  "col-start-14",
] as const;
const END = [
  "col-end-1",
  "col-end-2",
  "col-end-3",
  "col-end-4",
  "col-end-5",
  "col-end-6",
  "col-end-7",
  "col-end-8",
  "col-end-9",
  "col-end-10",
  "col-end-11",
  "col-end-12",
  "col-end-13",
  "col-end-14",
  "col-end-15",
] as const;
const DELAY = [
  "site-delay-1",
  "site-delay-2",
  "site-delay-3",
  "site-delay-4",
  "site-delay-5",
  "site-delay-6",
  "site-delay-7",
  "site-delay-8",
] as const;

type Tone = "confirmed" | "pending" | "block";
type Bar = { from: number; to: number; tone: Tone; label?: string };

const TONE: Record<Tone, string> = {
  confirmed: "cal-confirmed",
  pending: "cal-pending",
  block: "cal-block border border-navy-900/25 text-navy-900",
};

/** Temmuz 2027 (kurgusal): satır = hafta (Pzt–Paz), sütun = yarım gün (0–13). */
const JULY: { days: number[]; muted: number[]; bars: Bar[] }[] = [
  {
    days: [28, 29, 30, 1, 2, 3, 4],
    muted: [0, 1, 2],
    bars: [
      { from: 0, to: 11, tone: "confirmed", label: "Ayla Demir" },
      { from: 11, to: 14, tone: "confirmed", label: "Murat Kaya" },
    ],
  },
  {
    days: [5, 6, 7, 8, 9, 10, 11],
    muted: [],
    bars: [{ from: 0, to: 11, tone: "confirmed", label: "Murat Kaya" }],
  },
  {
    days: [12, 13, 14, 15, 16, 17, 18],
    muted: [],
    bars: [{ from: 1, to: 14, tone: "pending", label: "Selin Aksoy · Beklemede" }],
  },
  {
    days: [19, 20, 21, 22, 23, 24, 25],
    muted: [],
    bars: [
      { from: 0, to: 1, tone: "pending" },
      { from: 1, to: 11, tone: "confirmed", label: "Emre Yıldız" },
      { from: 11, to: 14, tone: "block", label: "Blok · Bakım" },
    ],
  },
  {
    days: [26, 27, 28, 29, 30, 31, 1],
    muted: [6],
    bars: [
      { from: 0, to: 1, tone: "block" },
      { from: 1, to: 14, tone: "confirmed", label: "Lena Hoffmann" },
    ],
  },
];

const WEEKDAYS = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];

/** Hareketli ay takvimi: bölüm görününce şeritler sırayla çizilir. */
export function MiniCalendar({
  className,
  rows = JULY.length,
  compact = false,
}: {
  className?: string;
  rows?: number;
  compact?: boolean;
}) {
  let n = 0;
  return (
    <div
      data-reveal="scale"
      aria-hidden="true"
      className={cn("overflow-hidden rounded-2xl border border-navy-900/10 bg-white", className)}
    >
      <div className="grid grid-cols-7 border-b border-navy-900/10 bg-mist/70 text-center text-[11px] font-medium text-navy-900/60">
        {WEEKDAYS.map((d) => (
          <span key={d} className="py-2">
            {d}
          </span>
        ))}
      </div>
      {JULY.slice(0, rows).map((week, w) => (
        <div key={w} className="relative border-b border-navy-900/10 last:border-b-0">
          <div className="grid grid-cols-7">
            {week.days.map((d, i) => (
              <span
                key={i}
                className={cn(
                  "border-r border-navy-900/10 px-2 pt-1.5 text-xs font-medium text-navy-900 last:border-r-0",
                  compact ? "h-12" : "h-14 sm:h-16",
                  week.muted.includes(i) && "bg-mist/80 text-navy-900/40",
                )}
              >
                {d}
              </span>
            ))}
          </div>
          <div className="absolute inset-x-0 bottom-2 grid grid-cols-14 gap-y-1">
            {week.bars.map((b, i) => (
              <span
                key={i}
                className={cn(
                  "site-draw row-start-1 h-5 truncate rounded-md px-1.5 text-[10px] leading-5 font-semibold sm:text-[11px]",
                  START[b.from],
                  END[b.to],
                  TONE[b.tone],
                  DELAY[Math.min(n++, DELAY.length - 1)],
                )}
              >
                {b.label}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function CalendarLegend({ invert = false }: { invert?: boolean }) {
  const item = "flex items-center gap-1.5";
  return (
    <ul
      className={cn(
        "flex flex-wrap gap-x-4 gap-y-1 text-xs",
        invert ? "text-white/75" : "text-navy-900/70",
      )}
    >
      <li className={item}>
        <span aria-hidden="true" className="h-2.5 w-5 rounded-full cal-confirmed" />
        Onaylı
      </li>
      <li className={item}>
        <span aria-hidden="true" className="h-2.5 w-5 rounded-full cal-pending" />
        Beklemede
      </li>
      <li className={item}>
        <span
          aria-hidden="true"
          className="h-2.5 w-5 rounded-full border border-navy-900/25 cal-block"
        />
        Blok
      </li>
    </ul>
  );
}

export function StatusChip({ status }: { status: "confirmed" | "pending" }) {
  return status === "confirmed" ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-turquoise-50 px-2 py-0.5 text-[11px] font-semibold text-turquoise-700">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-turquoise-500" />
      Onaylı
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500" />
      Beklemede
    </span>
  );
}

/** Paneldeki "Önerilen tutar" kartının aynısı (statik, kurgusal veri). */
export function QuoteMock({ quote, className }: { quote: Quote; className?: string }) {
  const c = quote.currency ?? "TRY";
  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 rounded-xl border border-navy-900/10 bg-white p-4 text-navy-900 shadow-xl shadow-navy-900/10",
        className,
      )}
    >
      <p className="text-sm font-semibold">Önerilen tutar</p>
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {quote.segments.map((s, i) => (
          <li key={s.from} className={cn("site-stagger flex justify-between gap-3", DELAY[i + 1])}>
            <span>
              {formatNights(s.from, s.to)} · {s.nights} gece
              <span className="block text-navy-900/55">{segmentFormula(s, c)}</span>
            </span>
            <span className="font-medium tabular-nums">{formatMoney(s.subtotalMinor ?? 0, c)}</span>
          </li>
        ))}
        {quote.cleaningFee ? (
          <li className="site-stagger site-delay-3 flex justify-between gap-3">
            <span>
              Temizlik ücreti
              <span className="block text-navy-900/55">
                {quote.cleaningFee.freeFromNights
                  ? `${quote.cleaningFee.freeFromNights} geceden kısa konaklamalarda, bir kez`
                  : "Konaklama başına bir kez"}
              </span>
            </span>
            <span className="font-medium tabular-nums">
              {formatMoney(quote.cleaningFee.amountMinor, c)}
            </span>
          </li>
        ) : null}
      </ul>
      <p className="flex justify-between border-t border-navy-900/10 pt-2 text-sm font-semibold">
        <span>Toplam · {quote.nights} gece</span>
        <span className="tabular-nums">{formatMoney(quote.totalMinor ?? 0, c)}</span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        <span className="rounded-md bg-navy-900 px-2.5 py-1 text-[11px] font-semibold text-white">
          Bu tutarı kullan
        </span>
        <span className="rounded-md border border-navy-900/15 px-2.5 py-1 text-[11px] font-semibold">
          WhatsApp ile gönder
        </span>
      </div>
    </div>
  );
}

/** WhatsApp mesaj balonu: metin quoteMessage çıktısıdır. */
export function WhatsAppBubble({
  text,
  className,
  clamp = false,
}: {
  text: string;
  className?: string;
  clamp?: boolean;
}) {
  return (
    <div className={cn("rounded-2xl bg-[#e7f6e9] p-1 shadow-xl shadow-navy-900/10", className)}>
      <div className="relative rounded-xl rounded-tr-sm bg-[#d9fdd3] px-3.5 pt-2.5 pb-5 text-[12.5px] leading-relaxed whitespace-pre-line text-[#111b21]">
        <p className={cn(clamp && "line-clamp-5")}>{text}</p>
        <span className="absolute right-2.5 bottom-1 text-[10px] text-[#667781]">
          10:42 <span className="text-[#53bdeb]">✓✓</span>
        </span>
      </div>
    </div>
  );
}

/** Kaydetme bildirimi (panel uyarı stili). */
export function ToastMock({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border border-navy-900/10 bg-white p-3.5 shadow-xl shadow-navy-900/10",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-turquoise-50 text-sm text-turquoise-700"
      >
        ✓
      </span>
      <div className="min-w-0 text-[13px] text-navy-900">
        <p className="font-semibold">Rezervasyon kaydedildi</p>
        <p className="text-navy-900/60">Selin Aksoy · 12–19 Temmuz 2027</p>
        <div className="mt-1.5">
          <StatusChip status="pending" />
        </div>
      </div>
    </div>
  );
}

/** Mülk kartı (kurgusal). */
export function PropertyCardMock({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-navy-900/10 bg-white text-navy-900 shadow-xl shadow-navy-900/10",
        className,
      )}
    >
      <div className="relative aspect-[3/2]">
        <DemoPhoto name="demo-havuz" alt="" />
        <span className="absolute top-2.5 left-2.5 rounded-md bg-navy-900/80 px-2 py-0.5 text-[11px] font-semibold text-white">
          Kapak
        </span>
      </div>
      <div className="flex flex-col gap-2 p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="font-bold">Villa Defne</p>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-turquoise-50 px-2 py-0.5 text-[11px] font-semibold text-turquoise-700">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-turquoise-500" />
            Aktif
          </span>
        </div>
        <p className="text-[13px] text-navy-900/60">Villa · Kaş, Antalya</p>
        <ul className="flex flex-wrap gap-1.5 text-[11px] font-medium">
          {["8 kişi", "4 yatak odası", "3 banyo", "Havuz 4 × 9 m"].map((t) => (
            <li key={t} className="rounded-md bg-mist px-2 py-1">
              {t}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const SEASON_TONE = [
  "bg-turquoise-500/25 text-navy-900",
  "bg-turquoise-500/50 text-navy-900",
  "bg-turquoise-700 text-white",
  "bg-turquoise-500/35 text-navy-900",
] as const;

/** Sezon şeridi: fiyat dönemleri yan yana (genişlikler sabit sınıflar: 2/1/2/2 ay). */
export function SeasonTimeline({
  periods,
  className,
  invert = false,
}: {
  periods: readonly RatePeriod[];
  className?: string;
  invert?: boolean;
}) {
  const span = ["sm:col-span-4", "sm:col-span-2", "sm:col-span-4", "sm:col-span-4"] as const;
  return (
    <div data-reveal className={cn("flex flex-col gap-2", className)}>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-14">
        {periods.map((p, i) => (
          <div
            key={p.id}
            className={cn(
              "site-draw flex min-h-20 flex-col justify-between rounded-xl p-2.5 sm:p-3",
              span[i % span.length],
              SEASON_TONE[i % SEASON_TONE.length],
              DELAY[i],
            )}
          >
            <span className="text-[11px] font-semibold opacity-80">
              {SAMPLE_SEASON_LABELS[p.id] ?? formatPeriod(p)}
            </span>
            <span className="text-sm font-bold tabular-nums sm:text-base">
              {p.nightlyAmountMinor
                ? formatMoney(p.nightlyAmountMinor, p.currency).replace(",00", "")
                : "—"}
              <span className="text-[10px] font-medium opacity-75"> /gece</span>
            </span>
          </div>
        ))}
      </div>
      <div
        className={cn(
          "hidden grid-cols-7 text-[11px] font-medium sm:grid",
          invert ? "text-white/55" : "text-navy-900/50",
        )}
      >
        {["Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim"].map((m) => (
          <span key={m}>{m}</span>
        ))}
      </div>
    </div>
  );
}
