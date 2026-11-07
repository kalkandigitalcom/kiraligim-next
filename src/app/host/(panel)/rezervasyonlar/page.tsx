import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import type { ReservationKind } from "@/lib/reservation-meta";
import { cn } from "@/lib/utils";
import { listProperties } from "@/server/properties/service";
import {
  canManageReservations,
  listReservations,
  type ReservationView,
} from "@/server/reservations/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { ReservationCard, toCardData } from "./_components/reservation-card";
import { ReservationSearch } from "./_components/reservation-search";

export const metadata: Metadata = { title: "Rezervasyonlar" };

const PAGE_SIZE = 20;

const VIEWS: { key: string; view: ReservationView; label: string; empty: string }[] = [
  { key: "yaklasan", view: "upcoming", label: "Yaklaşan", empty: "Yaklaşan kayıt yok." },
  {
    key: "konaklayan",
    view: "current",
    label: "Konaklayan",
    empty: "Şu an konaklayan misafir yok.",
  },
  { key: "gecmis", view: "past", label: "Geçmiş", empty: "Geçmiş kayıt yok." },
  { key: "iptal", view: "cancelled", label: "İptal", empty: "İptal edilmiş kayıt yok." },
];

const KINDS: { key: string; kind: ReservationKind | undefined; label: string }[] = [
  { key: "tumu", kind: undefined, label: "Tümü" },
  { key: "rezervasyon", kind: "reservation", label: "Rezervasyonlar" },
  { key: "blok", kind: "block", label: "Bloklar" },
];

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function ReservationsPage({ searchParams }: Props) {
  const sp = await searchParams;
  // Gizlilik: eski bağlantılardaki ?ara= (misafir adı) adres çubuğundan ve geçmişten temizlenir.
  if (sp.ara !== undefined) {
    const clean = new URLSearchParams();
    for (const k of ["gorunum", "tur", "mulk", "sayfa"] as const) {
      const v = one(sp[k]);
      if (v) clean.set(k, v);
    }
    const q = clean.toString();
    redirect(`/rezervasyonlar${q ? `?${q}` : ""}`);
  }
  const view = VIEWS.find((v) => v.key === one(sp.gorunum)) ?? VIEWS[0]!;
  const kind = KINDS.find((k) => k.key === one(sp.tur)) ?? KINDS[0]!;
  const page = Math.max(1, Math.min(500, Number.parseInt(one(sp.sayfa) ?? "1", 10) || 1));

  const data = await withPanelTenant(async (tx, ctx) => {
    const properties = await listProperties(tx);
    const propertyId = properties.some((p) => p.id === one(sp.mulk)) ? one(sp.mulk) : undefined;
    const list = await listReservations(tx, {
      view: view.view,
      kind: kind.kind,
      propertyId,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    });
    return { properties, propertyId, list, canManage: canManageReservations(ctx.role) };
  });
  const { properties, propertyId, list, canManage } = data;
  const hasActive = properties.some((p) => p.status === "active");
  const showProperty = properties.length > 1;

  const href = (over: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = {
      gorunum: view.key,
      tur: kind.key,
      mulk: propertyId,
      ...over,
    };
    for (const [k, v] of Object.entries(merged)) {
      if (v && !(k === "gorunum" && v === "yaklasan") && !(k === "tur" && v === "tumu")) {
        params.set(k, v);
      }
    }
    const s = params.toString();
    return `/rezervasyonlar${s ? `?${s}` : ""}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">
            Rezervasyonlar
          </h1>
          <p className="mt-1 text-[15px] text-muted-foreground">
            Rezervasyonları ve kapattığınız tarihleri (blok) buradan yönetin.
          </p>
        </div>
        {canManage && hasActive ? (
          <div className="flex gap-2">
            <Link
              href={`/rezervasyonlar/yeni${propertyId ? `?mulk=${propertyId}` : ""}`}
              className={buttonVariants({ className: "flex-1 sm:flex-none" })}
            >
              Yeni rezervasyon
            </Link>
            <Link
              href={`/rezervasyonlar/yeni?tur=blok${propertyId ? `&mulk=${propertyId}` : ""}`}
              className={buttonVariants({ variant: "secondary", className: "flex-1 sm:flex-none" })}
            >
              Blok ekle
            </Link>
          </div>
        ) : null}
      </div>

      {!canManage ? (
        <Alert tone="info">
          Rezervasyonları görüntüleyebilirsiniz; ekleme, düzenleme ve iptal yetkisi işletme sahibi
          ve yöneticilerdedir.
        </Alert>
      ) : null}
      {canManage && properties.length === 0 ? (
        <Alert tone="info">
          Rezervasyon eklemek için önce bir{" "}
          <Link href="/villalar/yeni" className="font-semibold underline">
            mülk ekleyin
          </Link>
          .
        </Alert>
      ) : null}

      <nav
        aria-label="Rezervasyon görünümleri"
        className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0"
      >
        <ul className="flex min-w-max gap-1 border-b border-border">
          {VIEWS.map((v) => (
            <li key={v.key}>
              <Link
                href={href({ gorunum: v.key, sayfa: undefined })}
                aria-current={v.key === view.key ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex border-b-2 px-3 py-2 text-sm font-semibold transition-colors",
                  v.key === view.key
                    ? "border-turquoise-500 text-navy-900"
                    : "border-transparent text-muted-foreground hover:text-navy-900",
                )}
              >
                {v.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {showProperty ? (
        <form
          method="get"
          action="/rezervasyonlar"
          aria-label="Mülke göre filtrele"
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          {view.key !== "yaklasan" ? <input type="hidden" name="gorunum" value={view.key} /> : null}
          {kind.key !== "tumu" ? <input type="hidden" name="tur" value={kind.key} /> : null}
          <div className="flex flex-col gap-1.5 sm:w-72">
            <label htmlFor="mulk" className="text-sm font-medium text-navy-900">
              Mülk
            </label>
            <select
              id="mulk"
              name="mulk"
              defaultValue={propertyId ?? ""}
              className="h-11 w-full rounded-lg border border-input bg-white px-3 pr-8 text-[15px] text-navy-900 focus-visible:border-turquoise-500 focus-visible:ring-3 focus-visible:ring-turquoise-500/25 focus-visible:outline-none"
            >
              <option value="">Tüm mülkler</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="secondary">
            Filtrele
          </Button>
        </form>
      ) : null}

      <div className="flex flex-wrap gap-2" aria-label="Kayıt türü">
        {KINDS.map((k) => (
          <Link
            key={k.key}
            href={href({ tur: k.key, sayfa: undefined })}
            aria-current={k.key === kind.key ? "true" : undefined}
            className={cn(
              "inline-flex h-8 items-center rounded-full border px-3 text-sm font-medium transition-colors",
              k.key === kind.key
                ? "border-navy-900 bg-navy-900 text-white"
                : "border-border bg-white text-navy-900 hover:bg-mist",
            )}
          >
            {k.label}
          </Link>
        ))}
      </div>

      <ReservationSearch
        view={view.view}
        viewLabel={view.label}
        kind={kind.kind}
        propertyId={propertyId}
        showProperty={showProperty}
      >
        {list.items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-white/60 px-6 py-12 text-center">
            <p className="font-semibold text-navy-900">{view.empty}</p>
          </div>
        ) : (
          <ul aria-label={`${view.label} kayıtlar`} className="flex flex-col gap-3">
            {list.items.map((r) => (
              <li key={r.id}>
                <ReservationCard r={toCardData(r)} showProperty={showProperty} />
              </li>
            ))}
          </ul>
        )}

        {page > 1 || list.hasMore ? (
          <nav aria-label="Sayfalar" className="flex items-center justify-between gap-3">
            {page > 1 ? (
              <Link
                href={href({ sayfa: String(page - 1) })}
                className={buttonVariants({ variant: "secondary" })}
              >
                ← Önceki
              </Link>
            ) : (
              <span />
            )}
            <span className="text-sm text-muted-foreground">Sayfa {page}</span>
            {list.hasMore ? (
              <Link
                href={href({ sayfa: String(page + 1) })}
                className={buttonVariants({ variant: "secondary" })}
              >
                Sonraki →
              </Link>
            ) : (
              <span />
            )}
          </nav>
        ) : null}
      </ReservationSearch>
    </div>
  );
}
