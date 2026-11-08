import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  type CalendarExternal,
  entriesInMonth,
  formatMonth,
  layoutMonth,
  mergeExternal,
  monthGrid,
  monthNav,
  resolveMonth,
  resolvePendingStart,
  splitExternal,
  toCalendarEntry,
} from "@/lib/calendar";
import { checkInWindow, istanbulToday } from "@/lib/reservation-meta";
import { listExternalBlocks } from "@/server/ical/service";
import { listProperties } from "@/server/properties/service";
import { canManageReservations, listCalendarEntries } from "@/server/reservations/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { CalendarSelectionProvider } from "./_components/calendar-selection";
import { MonthCalendar } from "./_components/month-calendar";
import { CalendarLegend, MonthList } from "./_components/month-list";
import { MonthNav } from "./_components/month-nav";

export const metadata: Metadata = { title: "Takvim" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/**
 * Rezervasyon takvimi (3.0c): tek mülk, aylık görünüm. URL'de yalnız mülk kimliği (?mulk), ay
 * (?ay=YYYY-MM) ve ay değiştirirken bekleyen giriş günü (?baslangic) bulunur; misafir bilgisi URL'ye
 * girmez. Mülk listesi ve kayıtlar RLS altında okunur: başka işletmenin mülk kimliği verilirse ilk
 * mülke düşülür. İptal edilen kayıtlar takvimde gösterilmez. İstemciye yalnız takvim DTO'su gider
 * (telefon/e-posta/tutar yok).
 *
 * Takvimden oluşturma (3.0c-3) yalnız Owner/Manager ve aktif mülkte açılır; seçim mevcut forma
 * ön doldurmalı bağlantı verir. Yetki, aktif mülk, tarih penceresi ve çakışma kuralları yine
 * action → servis → veritabanı zincirinde denetlenir.
 */
export default async function CalendarPage({ searchParams }: Props) {
  const sp = await searchParams;
  const today = istanbulToday();
  const month = resolveMonth(one(sp.ay), today);
  const grid = monthGrid(month, today);
  const dateWindow = checkInWindow(today);

  const data = await withPanelTenant(async (tx, ctx) => {
    const properties = await listProperties(tx);
    const property =
      properties.find((p) => p.id === one(sp.mulk)) ??
      properties.find((p) => p.status === "active") ??
      properties[0];
    const canCreate = canManageReservations(ctx.role) && property?.status === "active";
    // Önceki aydan taşınan giriş günü: aralığın tamamındaki çakışmalar bilinsin diye sorgu oradan başlar.
    const pendingStart = canCreate
      ? resolvePendingStart(one(sp.baslangic), dateWindow, grid.to)
      : null;
    const from = pendingStart && pendingStart < grid.from ? pendingStart : grid.from;
    const rows = property ? await listCalendarEntries(tx, property.id, from, grid.to) : [];
    // Harici takvim (iCal) dolulukları ayrı DTO ile gelir; rezervasyon olarak sayılmaz (3.1).
    const externals: CalendarExternal[] = property
      ? await listExternalBlocks(tx, property.id, from, grid.to)
      : [];
    return {
      externals,
      canCreate,
      pendingStart,
      properties: properties.map((p) => ({ id: p.id, name: p.name, status: p.status })),
      property: property ? { id: property.id, name: property.name, status: property.status } : null,
      entries: rows.flatMap((r) => toCalendarEntry(r) ?? []),
      canManage: canManageReservations(ctx.role),
    };
  });
  const { properties, property, entries, externals, canManage, canCreate, pendingStart } = data;
  const spans = mergeExternal(externals);
  // Şerit parçaları: etiket yalnız o günleri kapatan kaynakları gösterir (seçim birleşik aralığı kullanır).
  const pieces = splitExternal(spans);
  const nav = monthNav(month, today);
  const monthLabel = formatMonth(month);

  const href = (ay: string) => {
    const p = new URLSearchParams();
    if (property) p.set("mulk", property.id);
    if (ay !== nav.current) p.set("ay", ay);
    const s = p.toString();
    return `/takvim${s ? `?${s}` : ""}`;
  };
  const isActive = property?.status === "active";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">Takvim</h1>
          <p className="mt-1 text-[15px] text-muted-foreground">
            Mülkünüzün doluluğunu ve kapalı tarihlerini aylık olarak görün.
          </p>
        </div>
        {canManage && property && isActive ? (
          <div className="flex gap-2">
            <Link
              href={`/rezervasyonlar/yeni?mulk=${property.id}`}
              className={buttonVariants({ className: "flex-1 sm:flex-none" })}
            >
              Yeni rezervasyon
            </Link>
            <Link
              href={`/rezervasyonlar/yeni?tur=blok&mulk=${property.id}`}
              className={buttonVariants({ variant: "secondary", className: "flex-1 sm:flex-none" })}
            >
              Blok ekle
            </Link>
          </div>
        ) : null}
      </div>

      {!canManage ? (
        <Alert tone="info">
          Takvimi görüntüleyebilirsiniz; rezervasyon ekleme ve düzenleme yetkisi işletme sahibi ve
          yöneticilerdedir.
        </Alert>
      ) : null}

      {!property ? (
        <div className="rounded-2xl border border-dashed border-border bg-white/60 px-6 py-12 text-center">
          <p className="font-semibold text-navy-900">Henüz mülk yok.</p>
          {canManage ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Takvimi kullanmak için önce bir{" "}
              <Link href="/villalar/yeni" className="font-semibold text-turquoise-700 underline">
                mülk ekleyin
              </Link>
              .
            </p>
          ) : null}
        </div>
      ) : (
        <>
          {!isActive ? (
            <Alert tone="info">
              Bu mülk pasif. Mevcut kayıtlar görüntülenir; yeni rezervasyon veya blok eklenemez.
            </Alert>
          ) : null}

          <CalendarSelectionProvider
            key={`${property.id}:${month}:${pendingStart ?? ""}`}
            enabled={canCreate}
            min={dateWindow.min}
            max={dateWindow.max}
            entries={[...entries, ...spans]}
            initialStart={pendingStart}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              {properties.length > 1 ? (
                <form
                  method="get"
                  action="/takvim"
                  aria-label="Mülk seç"
                  className="flex items-end gap-2"
                >
                  {month !== nav.current ? <input type="hidden" name="ay" value={month} /> : null}
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:w-72 sm:flex-none">
                    <label htmlFor="mulk" className="text-sm font-medium text-navy-900">
                      Mülk
                    </label>
                    <select
                      key={property.id}
                      id="mulk"
                      name="mulk"
                      defaultValue={property.id}
                      className="h-11 w-full min-w-0 rounded-lg border border-input bg-white px-3 pr-8 text-[15px] text-navy-900 focus-visible:border-turquoise-500 focus-visible:ring-3 focus-visible:ring-turquoise-500/25 focus-visible:outline-none"
                    >
                      {properties.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.status === "active" ? "" : " (pasif)"}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button type="submit" variant="secondary">
                    Göster
                  </Button>
                </form>
              ) : (
                <p className="font-semibold text-navy-900">{property.name}</p>
              )}

              <MonthNav
                monthLabel={monthLabel}
                prevHref={nav.prev ? href(nav.prev) : null}
                nextHref={nav.next ? href(nav.next) : null}
                todayHref={month !== nav.current ? href(nav.current) : null}
              />
            </div>

            <CalendarLegend />

            <MonthCalendar
              monthLabel={monthLabel}
              propertyId={property.id}
              weeks={layoutMonth(grid, entries)}
              externalWeeks={layoutMonth(grid, pieces)}
              entries={entries}
              externals={externals}
              pieces={pieces}
            >
              <MonthList
                title={`${monthLabel} kayıtları`}
                entries={entriesInMonth(month, entries)}
                externals={entriesInMonth(month, externals)}
                propertyId={property.id}
              />
            </MonthCalendar>
          </CalendarSelectionProvider>

          <p className="text-sm text-muted-foreground">
            İptal edilen kayıtlar takvimde gösterilmez;{" "}
            <Link
              href={`/rezervasyonlar?gorunum=iptal&mulk=${property.id}`}
              className="font-medium text-turquoise-700 underline"
            >
              iptal listesine
            </Link>{" "}
            bakabilirsiniz.
          </p>
        </>
      )}
    </div>
  );
}
