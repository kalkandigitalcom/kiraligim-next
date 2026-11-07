import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { checkInWindow, istanbulToday, isIsoDate } from "@/lib/reservation-meta";
import { listProperties } from "@/server/properties/service";
import { canManageReservations } from "@/server/reservations/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { createReservationAction } from "../actions";
import { EMPTY_RESERVATION, type PropertyOption } from "../_components/form-values";
import { ReservationForm } from "../_components/reservation-form";

export const metadata: Metadata = { title: "Yeni kayıt" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * Yeni rezervasyon veya blok. ?tur=blok blok formuyla açar; ?mulk, ?giris, ?cikis ön doldurur
 * (takvimden gelinirken). Yalnız aktif mülkler listelenir; yetki ve kurallar action, servis ve
 * veritabanında yeniden denetlenir.
 */
export default async function NewReservationPage({ searchParams }: Props) {
  const sp = await searchParams;
  const isBlock = one(sp.tur) === "blok";
  const { properties, canManage } = await withPanelTenant(async (tx, ctx) => {
    const options: PropertyOption[] = (await listProperties(tx))
      .filter((p) => p.status === "active")
      .map((p) => ({ id: p.id, name: p.name, maxGuests: p.maxGuests }));
    return { properties: options, canManage: canManageReservations(ctx.role) };
  });

  const title = isBlock ? "Blok ekle" : "Yeni rezervasyon";
  const back = (
    <Link href="/rezervasyonlar" className="text-sm font-medium text-turquoise-700 hover:underline">
      ← Rezervasyonlar
    </Link>
  );
  if (!canManage) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        {back}
        <h1 className="text-2xl font-bold tracking-tight text-navy-900">{title}</h1>
        <Alert tone="info">
          Rezervasyon ve blok ekleme yetkisi işletme sahibi ve yöneticilerdedir.
        </Alert>
        <Link
          href="/rezervasyonlar"
          className={buttonVariants({ variant: "secondary", className: "self-start" })}
        >
          Rezervasyonlara dön
        </Link>
      </div>
    );
  }

  const prefillProperty = properties.some((p) => p.id === one(sp.mulk)) ? one(sp.mulk) : "";
  const date = (v: string) => (isIsoDate(v) ? v : "");
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {back}
      <h1 className="text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">{title}</h1>
      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8">
        <ReservationForm
          mode="create"
          action={createReservationAction}
          initial={{
            ...EMPTY_RESERVATION,
            kind: isBlock ? "block" : "reservation",
            propertyId: prefillProperty,
            checkIn: date(one(sp.giris)),
            checkOut: date(one(sp.cikis)),
          }}
          properties={properties}
          dateWindow={checkInWindow(istanbulToday())}
        />
      </div>
    </div>
  );
}
