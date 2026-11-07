import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { checkInWindow, istanbulToday, minorToInput } from "@/lib/reservation-meta";
import { getProperty } from "@/server/properties/service";
import {
  canManageReservations,
  getReservation,
  type Reservation,
} from "@/server/reservations/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { updateReservationAction } from "../../actions";
import type { ReservationFormValues } from "../../_components/form-values";
import { ReservationForm } from "../../_components/reservation-form";

export const metadata: Metadata = { title: "Kaydı düzenle" };

type Props = { params: Promise<{ id: string }> };

const toFormValues = (r: Reservation): ReservationFormValues => ({
  kind: r.kind,
  propertyId: r.propertyId,
  checkIn: r.checkIn,
  checkOut: r.checkOut,
  status: r.status,
  source: r.source ?? "direct",
  guestName: r.guestName ?? "",
  guestPhone: r.guestPhone ?? "",
  guestEmail: r.guestEmail ?? "",
  adults: r.adults === null ? "" : String(r.adults),
  children: r.children === null ? "0" : String(r.children),
  totalAmount: r.totalAmountMinor === null ? "" : minorToInput(r.totalAmountMinor),
  depositAmount: r.depositAmountMinor === null ? "" : minorToInput(r.depositAmountMinor),
  currency: r.currency ?? "TRY",
  note: r.note ?? "",
});

/** Kayıt düzenleme (owner/manager). İptal edilen kayıt ve staff → ayrıntı sayfasına döner. */
export default async function EditReservationPage({ params }: Props) {
  const { id } = await params;
  const view = await withPanelTenant(async (tx, ctx) => {
    const r = await getReservation(tx, id);
    const property = r ? await getProperty(tx, r.propertyId) : null;
    return { r, property, canManage: canManageReservations(ctx.role) };
  });
  const r = view.r;
  if (!r) notFound();
  if (!view.canManage || r.status === "cancelled") redirect(`/rezervasyonlar/${r.id}`);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Link
        href={`/rezervasyonlar/${r.id}`}
        className="text-sm font-medium text-turquoise-700 hover:underline"
      >
        ← Kayda dön
      </Link>
      <h1 className="text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">
        {r.kind === "block" ? "Bloğu düzenle" : "Rezervasyonu düzenle"}
      </h1>
      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8">
        <ReservationForm
          mode="edit"
          action={updateReservationAction.bind(null, r.id)}
          initial={toFormValues(r)}
          properties={[
            {
              id: r.propertyId,
              name: r.propertyName,
              maxGuests: view.property?.maxGuests ?? 0,
            },
          ]}
          dateWindow={checkInWindow(istanbulToday())}
          excludeId={r.id}
        />
      </div>
    </div>
  );
}
