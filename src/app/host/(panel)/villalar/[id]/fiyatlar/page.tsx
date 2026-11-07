import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import {
  adjacentSamePrice,
  formatNights,
  formatPeriod,
  lastNightOf,
  periodGaps,
  type RatePeriod,
  weeklyAboveNightly,
} from "@/lib/rate-meta";
import { checkInWindow, formatMoney, istanbulToday, minorToInput } from "@/lib/reservation-meta";
import { cn } from "@/lib/utils";
import { getProperty } from "@/server/properties/service";
import { canManageRates, listRates } from "@/server/rates/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { StatusBadge } from "../../_components/property-bits";
import { PropertyTabs } from "../../_components/property-tabs";
import { createRateAction, deleteRateAction, updateRateAction } from "./actions";
import { DeleteRate } from "./delete-rate";
import { RateForm, type RateFormValues } from "./rate-form";

export const metadata: Metadata = { title: "Fiyatlar" };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

const NOTICES: Record<string, string> = {
  eklendi: "Fiyat dönemi eklendi.",
  guncellendi: "Fiyat dönemi güncellendi.",
  "degisiklik-yok": "Değişiklik yapılmadı.",
  silindi: "Fiyat dönemi silindi; bu tarihler yeniden tanımlanabilir.",
};

const toFormValues = (r: RatePeriod): RateFormValues => ({
  startDate: r.startDate,
  lastNight: lastNightOf(r),
  nightlyAmount: r.nightlyAmountMinor === null ? "" : minorToInput(r.nightlyAmountMinor),
  weeklyAmount: r.weeklyAmountMinor === null ? "" : minorToInput(r.weeklyAmountMinor),
  currency: r.currency,
  minNights: r.minNights === null ? "" : String(r.minNights),
});

/**
 * Mülk fiyat dönemleri (Aşama 3.1). Tüm üyeler görür; owner/manager ekler, düzenler (?duzenle=<id>)
 * ve siler. Dönemler başlangıca göre sıralıdır; aradaki fiyatı tanımsız günler gösterilir.
 * Dönem tarihleri DAHİL gösterilir (gece sayısı gösterilmez: fiyat takvim günlerine tanımlanır).
 * Rezervasyon
 * tutarları bu fiyatlardan hesaplanmaz (ayrı aşama).
 */
export default async function PropertyRatesPage({ params, searchParams }: Props) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const view = await withPanelTenant(async (tx, ctx) => {
    const property = await getProperty(tx, id);
    return {
      property,
      rates: property ? await listRates(tx, property.id) : [],
      canManage: canManageRates(ctx.role),
    };
  });
  const p = view.property;
  if (!p) notFound();
  const { rates, canManage } = view;
  const today = istanbulToday();
  const editing = canManage ? rates.find((r) => r.id === one(sp.duzenle)) : undefined;
  const notice = NOTICES[one(sp.durum) ?? ""];
  const gaps = periodGaps(rates);
  const twins = new Set(adjacentSamePrice(rates));
  // Mülkün tek para birimi (3.2): ilk dönemden sonra kilitli. Düzenlenen dönem tek dönemse serbest.
  const lockedCurrency = rates.find((r) => r.id !== editing?.id)?.currency ?? null;
  const base = `/villalar/${p.id}/fiyatlar`;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Link href="/villalar" className="text-sm font-medium text-turquoise-700 hover:underline">
        ← Mülkler
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">
            {p.name}
          </h1>
          <p className="mt-1 text-[15px] text-muted-foreground">Fiyatlar</p>
        </div>
        <StatusBadge status={p.status} />
      </div>
      <PropertyTabs propertyId={p.id} active="rates" />

      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {!canManage ? (
        <Alert tone="info">
          Fiyatları görüntüleyebilirsiniz; fiyat ekleme ve düzenleme yetkisi işletme sahibi ve
          yöneticilerdedir.
        </Alert>
      ) : null}

      {canManage ? (
        <section
          id="fiyat-formu"
          aria-labelledby="rate-form-title"
          className="rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
        >
          <h2 id="rate-form-title" className="mb-4 font-semibold text-navy-900">
            {editing ? `Dönemi düzenle: ${formatPeriod(editing)}` : "Yeni fiyat dönemi"}
          </h2>
          <RateForm
            key={editing?.id ?? `new:${one(sp.kayit) ?? ""}:${one(sp.durum) ?? ""}`}
            mode={editing ? "edit" : "create"}
            action={
              editing ? updateRateAction.bind(null, editing.id) : createRateAction.bind(null, p.id)
            }
            initial={
              editing
                ? toFormValues(editing)
                : {
                    startDate: "",
                    lastNight: "",
                    nightlyAmount: "",
                    weeklyAmount: "",
                    currency: lockedCurrency ?? "TRY",
                    minNights: "",
                  }
            }
            periods={rates.map((r) => ({ id: r.id, startDate: r.startDate, endDate: r.endDate }))}
            editingId={editing?.id}
            lockedCurrency={lockedCurrency}
            dateWindow={checkInWindow(today)}
            cancelHref={editing ? base : undefined}
          />
        </section>
      ) : null}

      <section aria-labelledby="rate-list-title" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="rate-list-title" className="font-semibold text-navy-900">
            Fiyat dönemleri{" "}
            <span className="font-normal text-muted-foreground">({rates.length})</span>
          </h2>
        </div>
        {rates.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-white/60 px-6 py-10 text-center">
            <p className="font-semibold text-navy-900">Henüz fiyat dönemi yok.</p>
            {canManage ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Yukarıdaki formla bir tarih aralığı için gecelik ve/veya haftalık fiyat ekleyin.
              </p>
            ) : null}
          </div>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Fiyat dönemleri">
            {rates.map((r) => {
              const gap = gaps.find((g) => g.afterId === r.id);
              const past = r.endDate <= today;
              const current = r.startDate <= today && today < r.endDate;
              const label = formatPeriod(r);
              return (
                <li key={r.id} className="flex flex-col gap-3">
                  <article
                    data-testid="rate-row"
                    aria-label={label}
                    className={cn(
                      "flex flex-col gap-3 rounded-2xl border bg-white p-4 shadow-sm sm:p-5",
                      r.id === editing?.id || r.id === one(sp.kayit)
                        ? "border-turquoise-500"
                        : "border-border",
                      past && "opacity-70",
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-navy-900">{label}</p>
                      </div>
                      {current ? (
                        <span className="rounded-full bg-turquoise-50 px-2.5 py-0.5 text-xs font-semibold text-turquoise-700">
                          Şu an geçerli
                        </span>
                      ) : past ? (
                        <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                          Geçmiş
                        </span>
                      ) : null}
                    </div>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                      <div>
                        <dt className="text-muted-foreground">Gecelik</dt>
                        <dd
                          className="font-semibold text-navy-900 tabular-nums"
                          data-testid="rate-nightly"
                        >
                          {r.nightlyAmountMinor === null
                            ? "—"
                            : formatMoney(r.nightlyAmountMinor, r.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Haftalık (7 gece)</dt>
                        <dd
                          className="font-semibold text-navy-900 tabular-nums"
                          data-testid="rate-weekly"
                        >
                          {r.weeklyAmountMinor === null
                            ? "—"
                            : formatMoney(r.weeklyAmountMinor, r.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Minimum konaklama</dt>
                        <dd className="text-navy-900">
                          {r.minNights === null ? "—" : `${r.minNights} gece`}
                        </dd>
                      </div>
                    </dl>
                    {weeklyAboveNightly(r) ? (
                      <p data-testid="rate-weekly-warning" className="text-sm text-amber-900">
                        Haftalık fiyat 7 gecelik gecelik toplamdan (
                        {formatMoney(7 * (r.nightlyAmountMinor ?? 0), r.currency)}) yüksek; 7 gece
                        ve üzeri konaklamalarda tanımlanan haftalık fiyat kullanılır.
                      </p>
                    ) : null}
                    {canManage ? (
                      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                        <Link
                          href={`${base}?duzenle=${r.id}#fiyat-formu`}
                          className={buttonVariants({ variant: "secondary", size: "sm" })}
                          aria-label={`Düzenle: ${label}`}
                        >
                          Düzenle
                        </Link>
                        <DeleteRate action={deleteRateAction.bind(null, r.id)} label={label} />
                      </div>
                    ) : null}
                  </article>
                  {gap ? (
                    <p
                      data-testid="rate-gap"
                      className="rounded-xl border border-dashed border-amber-500/60 bg-amber-50 px-4 py-2 text-sm text-amber-900"
                    >
                      Fiyatı tanımsız {gap.nights === 1 ? "gün" : "günler"}:{" "}
                      {formatNights(gap.from, gap.to)}
                    </p>
                  ) : null}
                  {twins.has(r.id) ? (
                    <p
                      data-testid="rate-twin"
                      className="rounded-xl border border-dashed border-border bg-white/60 px-4 py-2 text-sm text-muted-foreground"
                    >
                      Bu dönem ile sonraki dönem aynı fiyatta. Haftalık fiyat dönem sınırında
                      bölünür; kesintisiz uygulanması için bunları tek dönem olarak
                      tanımlayabilirsiniz.
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <div className="rounded-xl border border-border bg-white/60 px-4 py-3 text-sm text-muted-foreground">
          <p className="font-medium text-navy-900">Konaklama fiyatı nasıl hesaplanır?</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>
              Fiyat dönemlerinin başlangıç ve bitiş günleri dahildir. Konaklamada giriş günü dahil,
              çıkış günü hariçtir: her konaklama gecesi, o günün fiyat dönemiyle hesaplanır.
            </li>
            <li>
              Haftalık fiyat, aynı dönem içindeki 7 gecelik bloklara uygulanır; kalan geceler
              gecelik fiyatla hesaplanır. Haftalık bloklar dönem sınırında bölünür.
            </li>
            <li>Konaklama gecelerinden birinin bile fiyatı tanımlı değilse toplam hesaplanmaz.</li>
            <li>Minimum konaklama, giriş tarihinin dönemine göre uyarı olarak gösterilir.</li>
            <li>
              Hesaplanan tutar rezervasyon formunda önerilir; yalnız siz onaylarsanız kullanılır.
              Kayıtlı rezervasyonların tutarları değişmez.
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
