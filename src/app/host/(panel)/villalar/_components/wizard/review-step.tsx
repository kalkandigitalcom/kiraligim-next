import { ChevronRight, CircleAlert, CircleCheck, Pencil } from "lucide-react";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { formatMeters, POOL_KINDS, POOL_LABELS, PROPERTY_TYPE_LABELS } from "@/lib/property-meta";
import { effectiveMapMode, MAP_MODE_LABELS } from "@/lib/map-pin";
import { type EditStep, stepHref, WIZARD_STEP_LABELS } from "@/lib/property-wizard";
import { AMENITY_LABELS, orderAmenities } from "@/lib/public-profile-meta";
import {
  DISTANCE_KEYS,
  DISTANCE_LABELS,
  formatDistance,
  HOUSE_RULE_LABELS,
  PRICE_INCLUDE_LABELS,
} from "@/lib/villa-extras";
import type { PublicProfile } from "@/server/properties/public-profile";
import type { Property } from "@/server/properties/service";

import type { StatusFormState } from "../../actions";
import { StatusBadge } from "../property-bits";
import { StatusToggle } from "../status-toggle";

type Props = {
  property: Property;
  profile: PublicProfile;
  canManage: boolean;
  statusAction: (state: StatusFormState, data: FormData) => Promise<StatusFormState>;
};

type Missing = { step: EditStep; text: string; required?: boolean };

/** Eksik bilgiler (yayın için gerekli olanlar işaretlenir). Zorunlu alanlar 1. adımda denetlenir. */
export function missingItems(p: Property, pp: PublicProfile): Missing[] {
  const out: Missing[] = [];
  if (pp.photoCount === 0) {
    out.push({ step: "aciklama", text: "Fotoğraf ekleyin", required: true });
  }
  if (!p.descriptionHtml && !p.description) {
    out.push({ step: "aciklama", text: "Villanızı anlatan bir açıklama yazın" });
  }
  if (pp.amenities.length === 0) out.push({ step: "olanaklar", text: "Olanakları işaretleyin" });
  if (!pp.checkInTime || !pp.checkOutTime) {
    out.push({ step: "konaklama", text: "Giriş ve çıkış saatlerini girin" });
  }
  if (!effectiveMapMode(p.mapMode, p.mapEmbedUrl, p.mapPin))
    out.push({ step: "temel", text: "Haritada villanızın yerini ekleyin" });
  if (pp.houseRuleKeys.length === 0 && !pp.houseRules) {
    out.push({ step: "konaklama", text: "Ev kurallarını işaretleyin" });
  }
  return out;
}

/** Misafirin göreceği harita yöntemi. */
function mapSummary(p: Property): string {
  const mode = effectiveMapMode(p.mapMode, p.mapEmbedUrl, p.mapPin);
  return mode ? `${MAP_MODE_LABELS[mode]} ile eklendi` : "—";
}

const dash = (v: string | null | undefined) => (v && v.trim() ? v : "—");
const excerpt = (v: string | null, n = 180) => {
  if (!v || !v.trim()) return "—";
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t;
};

function Chips({ labels }: { labels: string[] }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {labels.map((l) => (
        <span key={l} className="rounded-full bg-mist px-2.5 py-0.5 text-xs">
          {l}
        </span>
      ))}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 py-2 sm:grid-cols-[11rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words text-navy-900">{children}</dd>
    </div>
  );
}

function Summary({
  step,
  propertyId,
  canManage,
  children,
}: {
  step: EditStep;
  propertyId: string;
  canManage: boolean;
  children: React.ReactNode;
}) {
  const id = `ozet-${step}`;
  return (
    <section
      aria-labelledby={id}
      className="rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
      data-testid={id}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 id={id} className="text-base font-semibold text-navy-900">
          {WIZARD_STEP_LABELS[step]}
        </h3>
        <Link
          href={stepHref(propertyId, step)}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
          aria-label={`${WIZARD_STEP_LABELS[step]}: ${canManage ? "düzenle" : "görüntüle"}`}
        >
          {canManage ? <Pencil aria-hidden className="size-3.5" /> : null}
          {canManage ? "Düzenle" : "Görüntüle"}
        </Link>
      </div>
      <dl className="divide-y divide-border">{children}</dl>
    </section>
  );
}

/** 5. adım: bölüm bölüm özet, eksikler, aktif/pasif ve yayın sayfasına geçiş. */
export function ReviewStep({ property: p, profile: pp, canManage, statusAction }: Props) {
  const missing = missingItems(p, pp);
  const amenities = orderAmenities(pp.amenities);
  const pools = POOL_KINDS.filter((k) => p.pools[k].present).map((k) => {
    const x = p.pools[k];
    const size =
      x.width !== null && x.length !== null
        ? `${formatMeters(x.width)} × ${formatMeters(x.length)} m`
        : null;
    const depth = x.depth !== null ? `derinlik ${formatMeters(x.depth)} m` : null;
    const extra = [size, depth].filter(Boolean).join(", ");
    return `${POOL_LABELS[k]}${extra ? ` (${extra})` : ""}`;
  });
  const place = [p.neighborhood, p.district, p.province].filter(Boolean).join(", ");
  const distances = DISTANCE_KEYS.flatMap((key) => {
    const km = p.distances[key];
    return km === null ? [] : [{ key, km, unit: p.distanceUnits[key] }];
  });
  const published = pp.visibility.state === "published";

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-labelledby="eksik-baslik"
        className="rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
        data-testid="missing"
      >
        {missing.length === 0 ? (
          <div className="flex items-start gap-3">
            <CircleCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-turquoise-700" />
            <div>
              <h3 id="eksik-baslik" className="font-semibold text-navy-900">
                Bilgileriniz tamam
              </h3>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Tüm bölümler dolduruldu. Villa sayfanızı yayın ayarlarından yayınlayabilirsiniz.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-amber-600" />
              <div>
                <h3 id="eksik-baslik" className="font-semibold text-navy-900">
                  Eksik bilgiler ({missing.length})
                </h3>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Bunları tamamlamanız misafirlerin karar vermesini kolaylaştırır.
                </p>
              </div>
            </div>
            <ul className="mt-3 flex flex-col gap-2">
              {missing.map((m) => (
                <li
                  key={m.text}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-mist px-3 py-2 text-sm"
                  data-testid="missing-item"
                >
                  <span className="text-navy-900">
                    {m.text}
                    {m.required ? (
                      <span className="ml-1 text-xs font-semibold text-amber-700">
                        · villa sayfasını yayınlamak için gerekli
                      </span>
                    ) : null}
                  </span>
                  <Link
                    href={stepHref(p.id, m.step)}
                    className="font-medium text-turquoise-700 hover:underline"
                  >
                    {canManage ? "Tamamla" : "Görüntüle"}
                    <span className="sr-only">: {WIZARD_STEP_LABELS[m.step]}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <Summary step="temel" propertyId={p.id} canManage={canManage}>
        <Row label="Mülk adı">{p.name}</Row>
        <Row label="Mülk türü">{PROPERTY_TYPE_LABELS[p.propertyType]}</Row>
        <Row label="Konum">{place}</Row>
        <Row label="Kapasite">
          {p.maxGuests} kişi · {p.bedrooms} yatak odası · {p.bathrooms} banyo
        </Row>
        <Row label="Harita">{mapSummary(p)}</Row>
        <Row label="Mesafeler">
          {distances.length === 0
            ? "—"
            : distances
                .map((d) => `${DISTANCE_LABELS[d.key]} ${formatDistance(d.km, d.unit)}`)
                .join(" · ")}
        </Row>
        <Row label="Belge no">{dash(p.tourismLicenseNo)}</Row>
      </Summary>

      <Summary step="aciklama" propertyId={p.id} canManage={canManage}>
        <Row label="Açıklama">{excerpt(p.description)}</Row>
        <Row label="Fotoğraflar">
          {pp.photoCount === 0 ? "Henüz fotoğraf yok" : `${pp.photoCount} fotoğraf`}
        </Row>
        <Row label="Video">{p.youtubeVideoIds.length === 0 ? "—" : "Eklendi"}</Row>
      </Summary>

      <Summary step="olanaklar" propertyId={p.id} canManage={canManage}>
        <Row label="Olanaklar">
          {amenities.length === 0 ? (
            "—"
          ) : (
            <span className="flex flex-wrap gap-1.5">
              {amenities.map((k) => (
                <span key={k} className="rounded-full bg-mist px-2.5 py-0.5 text-xs">
                  {AMENITY_LABELS[k]}
                </span>
              ))}
            </span>
          )}
        </Row>
        <Row label="Havuz">{pools.length === 0 ? "Havuz yok" : pools.join(" · ")}</Row>
      </Summary>

      <Summary step="konaklama" propertyId={p.id} canManage={canManage}>
        <Row label="Giriş / çıkış">
          {dash(pp.checkInTime)} / {dash(pp.checkOutTime)}
        </Row>
        <Row label="Ev kuralları">
          {pp.houseRuleKeys.length === 0 ? (
            excerpt(pp.houseRules)
          ) : (
            <span className="flex flex-col gap-1">
              <Chips labels={pp.houseRuleKeys.map((k) => HOUSE_RULE_LABELS[k] ?? k)} />
              {pp.houseRules ? <span>Ek not: {excerpt(pp.houseRules, 120)}</span> : null}
            </span>
          )}
        </Row>
        <Row label="Fiyata dahil">
          {pp.priceIncludes.length === 0 ? (
            "—"
          ) : (
            <Chips labels={pp.priceIncludes.map((k) => PRICE_INCLUDE_LABELS[k] ?? k)} />
          )}
        </Row>
      </Summary>

      <section
        aria-labelledby="durum-baslik"
        className="rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
        data-testid="review-status"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 id="durum-baslik" className="text-base font-semibold text-navy-900">
            Mülk durumu
          </h3>
          <StatusBadge status={p.status} />
        </div>
        {canManage ? (
          <StatusToggle status={p.status} action={statusAction} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Durumu değiştirme yetkisi işletme sahibi ve yöneticilerdedir.
          </p>
        )}
      </section>

      <section
        aria-labelledby="yayin-baslik"
        className="flex flex-col gap-3 rounded-2xl border border-border bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6"
        data-testid="review-publish"
      >
        <div>
          <h3 id="yayin-baslik" className="text-base font-semibold text-navy-900">
            Villa sayfası
          </h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {published
              ? "Villa sayfanız yayında; misafirler bağlantıdan açabilir."
              : "Villa sayfanız henüz yayında değil. Sayfa adresini ve yayını buradan yönetin."}
          </p>
        </div>
        <Link
          href={`/villalar/${p.id}/yayin`}
          className={buttonVariants({ className: "w-full shrink-0 sm:w-auto" })}
        >
          Yayın ayarlarına git
          <ChevronRight aria-hidden className="size-4" />
        </Link>
      </section>
    </div>
  );
}
