import { POOL_KINDS, POOL_LABELS, formatMeters } from "@/lib/property-meta";
import type { PublicVilla } from "@/lib/public-villa";
import { amenityGroups, type RateRow, rateRows } from "@/lib/public-villa-view";
import { formatNights } from "@/lib/rate-meta";
import {
  DISTANCE_LABELS,
  formatDistance,
  HOUSE_RULE_LABELS,
  PRICE_INCLUDE_LABELS,
} from "@/lib/villa-extras";
import { youtubeWatchUrl } from "@/lib/youtube";

/** Sayfa bölümü: başlık + içerik; bağlantılı başlık kimlikleri sabittir (testler ve içindekiler). */
export function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-baslik`}
      className="scroll-mt-6 border-t border-border py-9 first:border-t-0 first:pt-0"
    >
      <h2 id={`${id}-baslik`} className="mb-5 text-xl font-bold tracking-tight sm:text-2xl">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Kişi, oda, banyo: kısa ve taranabilir bilgi şeridi. */
export function KeyFacts({ v }: { v: PublicVilla }) {
  const facts = [
    { icon: <GuestsIcon />, label: `${v.maxGuests} kişi` },
    { icon: <BedIcon />, label: `${v.bedrooms} yatak odası` },
    { icon: <BathIcon />, label: `${v.bathrooms} banyo` },
    // Veride özel / ortak havuz ayrımı yok: yalnız "Yüzme havuzu" denir.
    ...(v.pools.swimming ? [{ icon: <PoolIcon />, label: "Yüzme havuzu" }] : []),
  ];
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Öne çıkan bilgiler">
      {facts.map((f) => (
        <li
          key={f.label}
          className="inline-flex items-center gap-2 rounded-full border border-border bg-white px-3.5 py-2 text-[15px] font-medium"
        >
          <span className="text-turquoise-700">{f.icon}</span>
          {f.label}
        </li>
      ))}
    </ul>
  );
}

export function Description({ html }: { html: string }) {
  return (
    <div
      className="max-w-prose text-[16px] leading-relaxed text-navy-900/85 [&_a]:font-medium [&_a]:text-turquoise-700 [&_a]:underline [&_a]:underline-offset-2 [&_p]:mb-4 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_strong]:text-navy-900"
      // Kaynak: F2a'da sanitizeDescription'dan YENİDEN geçirilmiş HTML (yalnız p, br, strong, em,
      // u ve güvenli a). Ham kullanıcı girdisi buraya ulaşmaz.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function Amenities({ keys }: { keys: string[] }) {
  const groups = amenityGroups(keys);
  return (
    <div className="grid gap-x-10 gap-y-7 sm:grid-cols-2">
      {groups.map((g) => (
        <div key={g.key}>
          <h3 className="mb-3 text-sm font-bold tracking-wide text-navy-900/60 uppercase">
            {g.label}
          </h3>
          <ul className="flex flex-col gap-2.5">
            {g.items.map((a) => (
              <li key={a.key} className="flex items-start gap-2.5 text-[15px]">
                <CheckIcon />
                {a.label}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export const hasPools = (p: PublicVilla["pools"]) => POOL_KINDS.some((k) => p[k] !== null);

export function Pools({ pools }: { pools: PublicVilla["pools"] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {POOL_KINDS.map((k) => {
        const p = pools[k];
        if (!p) return null;
        return (
          <li key={k} className="rounded-2xl border border-border bg-mist/60 p-4">
            <p className="font-semibold">{POOL_LABELS[k]}</p>
            <p className="mt-1 text-[15px] text-navy-900/75">
              {formatMeters(p.width)} × {formatMeters(p.length)} m · derinlik{" "}
              {formatMeters(p.depth)} m
            </p>
            {/* Panelde "Korunaklı havuz" (çitli / güvenlikli). Yalnız olumlu beyan gösterilir:
                false hem "Hayır" hem "belirtilmedi" olabilir (varsayılan), iddia edilmez. */}
            {p.protected === true && (
              <p className="mt-1 text-sm font-medium text-turquoise-700">Korunaklı havuz</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Yakın yerlere mesafeler: yalnız girilmiş olanlar (km / m). */
export function Distances({ items }: { items: PublicVilla["distances"] }) {
  return (
    <ul className="grid gap-2.5 sm:grid-cols-2" data-testid="villa-distances">
      {items.map((d) => (
        <li
          key={d.key}
          className="flex items-center justify-between gap-4 rounded-2xl border border-border px-4 py-3 text-[15px]"
        >
          <span className="text-navy-900/75">{DISTANCE_LABELS[d.key]}</span>
          <span className="font-semibold tabular-nums">{formatDistance(d.km, d.unit)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Onay işaretli kısa liste (ev kuralları, fiyata dahil olanlar). */
function CheckList({
  keys,
  labels,
  testId,
}: {
  keys: string[];
  labels: Record<string, string>;
  testId: string;
}) {
  return (
    <ul className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2" data-testid={testId}>
      {keys.map((k) => (
        <li key={k} className="flex items-start gap-2.5 text-[15px]">
          <CheckIcon />
          {labels[k]}
        </li>
      ))}
    </ul>
  );
}

/** Fiyata dahil olanlar (bilgi amaçlı). */
export function PriceIncludes({ keys }: { keys: string[] }) {
  return <CheckList keys={keys} labels={PRICE_INCLUDE_LABELS} testId="villa-price-includes" />;
}

/**
 * Giriş/çıkış saatleri ve ev kuralları (hazır seçenekler + ek not; satır sonları korunur).
 * Revizyon 2: iptal ve ödeme koşulları bölümü kaldırıldı.
 */
export function Terms({ v }: { v: PublicVilla }) {
  const hasRules = v.houseRuleKeys.length > 0 || !!v.houseRules;
  return (
    <div className="flex flex-col gap-6">
      {(v.checkInTime || v.checkOutTime) && (
        <dl className="grid max-w-md grid-cols-2 gap-3">
          {v.checkInTime && (
            <div className="rounded-2xl border border-border p-4">
              <dt className="text-sm text-navy-900/60">En erken giriş</dt>
              <dd className="text-lg font-semibold">{v.checkInTime}</dd>
            </div>
          )}
          {v.checkOutTime && (
            <div className="rounded-2xl border border-border p-4">
              <dt className="text-sm text-navy-900/60">En geç çıkış</dt>
              <dd className="text-lg font-semibold">{v.checkOutTime}</dd>
            </div>
          )}
        </dl>
      )}
      {hasRules && (
        <div data-testid="terms-ev-kurallari">
          <h3 className="mb-3 font-semibold">Ev kuralları</h3>
          {v.houseRuleKeys.length > 0 && (
            <CheckList
              keys={v.houseRuleKeys}
              labels={HOUSE_RULE_LABELS}
              testId="villa-house-rules"
            />
          )}
          {v.houseRules && (
            <p
              className={`max-w-prose text-[15px] leading-relaxed whitespace-pre-line text-navy-900/80 ${v.houseRuleKeys.length > 0 ? "mt-4" : ""}`}
              data-testid="villa-house-rules-extra"
            >
              {v.houseRules}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export const hasTerms = (v: PublicVilla) =>
  !!(v.checkInTime || v.checkOutTime || v.houseRules || v.houseRuleKeys.length > 0);

/** Sezon fiyatları: yalnız bugünden sonraki geceler; fiyatsız dönem "sorunuz" olarak gösterilir. */
export function RatesTable({ rates, today }: { rates: PublicVilla["rates"]; today: string }) {
  const rows = rateRows(rates, today);
  if (rows.length === 0) {
    return (
      <p className="text-[15px] text-navy-900/75">
        Bu villa için henüz fiyat dönemi girilmemiş. Fiyat bilgisi için ev sahibine
        WhatsApp&apos;tan ulaşabilirsiniz.
      </p>
    );
  }
  return (
    <>
      {/* Mobil: kartlar */}
      <ul className="flex flex-col gap-3 sm:hidden" aria-label="Sezon fiyatları">
        {rows.map((r) => (
          <li key={r.id} className="rounded-2xl border border-border p-4">
            <p className="font-semibold">{formatNights(r.startDate, r.endDate)}</p>
            <RateFacts r={r} />
          </li>
        ))}
      </ul>
      {/* Geniş ekran: tablo */}
      <div className="hidden overflow-hidden rounded-2xl border border-border sm:block">
        <table className="w-full text-left text-[15px]">
          <caption className="sr-only">Sezon fiyatları</caption>
          <thead className="bg-mist text-sm text-navy-900/65">
            <tr>
              <th scope="col" className="px-4 py-3 font-semibold">
                Dönem
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                Gecelik
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                Haftalık
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                En az
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                Temizlik
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id}>
                <th scope="row" className="px-4 py-3 font-medium">
                  {formatNights(r.startDate, r.endDate)}
                </th>
                <td className="px-4 py-3 font-semibold whitespace-nowrap">
                  {r.nightly ?? "Sorunuz"}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">{r.weekly ?? "—"}</td>
                <td className="px-4 py-3 whitespace-nowrap">
                  {r.minNights ? `${r.minNights} gece` : "—"}
                </td>
                <td className="px-4 py-3">
                  {r.cleaning ? (
                    <>
                      {r.cleaning}
                      {r.cleaningFreeFrom && (
                        <span className="block text-sm text-navy-900/60">
                          {r.cleaningFreeFrom} gece ve üzeri ücretsiz
                        </span>
                      )}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-navy-900/60">
        Haftalık fiyat konaklamanın her 7 gecesine, kalan gecelere gecelik fiyat uygulanır. Temizlik
        ücreti konaklama başına bir kez eklenir. Kesin tutar için ev sahibiyle görüşün.
      </p>
    </>
  );
}

function RateFacts({ r }: { r: RateRow }) {
  const items = [
    ["Gecelik", r.nightly ?? "Sorunuz"],
    ["Haftalık", r.weekly],
    ["En az", r.minNights ? `${r.minNights} gece` : null],
    [
      "Temizlik",
      r.cleaning
        ? `${r.cleaning}${r.cleaningFreeFrom ? ` (${r.cleaningFreeFrom} gece ve üzeri ücretsiz)` : ""}`
        : null,
    ],
  ].filter((x): x is [string, string] => x[1] !== null);
  return (
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[15px]">
      {items.map(([k, val]) => (
        <div key={k} className="contents">
          <dt className="text-navy-900/60">{k}</dt>
          <dd className="font-medium">{val}</dd>
        </div>
      ))}
    </dl>
  );
}

/** YouTube videosu (tek): gömülü oynatıcı yok (CSP, KVKK); yalnız dış bağlantı (F2 kararı). */
export function Video({ id, name }: { id: string; name: string }) {
  return (
    <a
      href={youtubeWatchUrl(id)}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-[15px] font-semibold hover:bg-mist focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
      aria-label={`${name} videosu (YouTube, yeni sekmede açılır)`}
      data-testid="villa-video"
    >
      <PlayIcon />
      Videoyu izle
      <span className="text-sm font-normal text-navy-900/55">YouTube</span>
    </a>
  );
}

// --- Simgeler (satır içi SVG; CSP'ye uygun) ---------------------------------------------------

const icon = "size-5 fill-none stroke-current stroke-[1.8]";
const GuestsIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={icon}>
    <circle cx="9" cy="8" r="3.2" />
    <path
      d="M3.5 19c.6-3.2 2.9-5 5.5-5s4.9 1.8 5.5 5M15.5 5.3a3 3 0 010 5.4M17.5 14.4c1.6.7 2.7 2.3 3 4.6"
      strokeLinecap="round"
    />
  </svg>
);
const BedIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={icon}>
    <path
      d="M3 18V7M3 14h18v4M21 14v-2.5A2.5 2.5 0 0018.5 9H11v5M7 11.5a1.5 1.5 0 100-.01"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const BathIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={icon}>
    <path
      d="M4 12h16v2a5 5 0 01-5 5H9a5 5 0 01-5-5v-2zM6 12V6a2 2 0 013.6-1.2M7 19l-1 2M17 19l1 2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const PoolIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={icon}>
    <path
      d="M3 17c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 4.5 0 3-1 4.5 0M8 14V5a2 2 0 014 0M16 14V5a2 2 0 014 0M8 8h8M8 11h8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const CheckIcon = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className="mt-0.5 size-5 shrink-0 fill-none stroke-turquoise-700 stroke-2"
  >
    <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const PlayIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 fill-current text-[#c4302b]">
    <path d="M10 8.5v7l6-3.5-6-3.5z" />
    <rect
      x="2.5"
      y="5"
      width="19"
      height="14"
      rx="4"
      className="fill-none stroke-current stroke-[1.8]"
    />
  </svg>
);
