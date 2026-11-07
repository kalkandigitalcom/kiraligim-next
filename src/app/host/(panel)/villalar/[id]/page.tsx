import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-meta";
import { canManageProperties, getProperty, type Property } from "@/server/properties/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { setPropertyStatusAction, updatePropertyAction } from "../actions";
import { StatusBadge } from "../_components/property-bits";
import { PropertyForm, type PropertyFormValues } from "../_components/property-form";
import { StatusToggle } from "../_components/status-toggle";

export const metadata: Metadata = { title: "Mülk" };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const toFormValues = (p: Property): PropertyFormValues => ({
  name: p.name,
  propertyType: p.propertyType,
  description: p.description ?? "",
  maxGuests: String(p.maxGuests),
  bedrooms: String(p.bedrooms),
  bathrooms: String(p.bathrooms),
  bedsDouble: String(p.bedsDouble),
  bedsSingle: String(p.bedsSingle),
  bedsSofa: String(p.bedsSofa),
  province: p.province,
  district: p.district,
  neighborhood: p.neighborhood ?? "",
  addressLine: p.addressLine ?? "",
  postalCode: p.postalCode ?? "",
  latitude: p.latitude === null ? "" : p.latitude.toFixed(6),
  longitude: p.longitude === null ? "" : p.longitude.toFixed(6),
});

const NOTICES: Record<string, string> = {
  olusturuldu: "Mülk oluşturuldu.",
  pasif: "Mülk pasife alındı.",
  aktif: "Mülk aktif edildi.",
};

export default async function PropertyPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { durum } = await searchParams;
  // RLS: başka işletmenin mülkü veya geçersiz kimlik → null → 404 (varlık sızdırılmaz).
  const view = await withPanelTenant(async (tx, ctx) => ({
    property: await getProperty(tx, id),
    canManage: canManageProperties(ctx.role),
  }));
  const p = view.property;
  if (!p) notFound();
  const notice = typeof durum === "string" ? NOTICES[durum] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Link href="/villalar" className="text-sm font-medium text-turquoise-700 hover:underline">
        ← Mülkler
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">
            {p.name}
          </h1>
          <p className="mt-1 text-[15px] text-muted-foreground">
            {PROPERTY_TYPE_LABELS[p.propertyType]} · {p.district}, {p.province}
          </p>
        </div>
        <StatusBadge status={p.status} />
      </div>

      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {!view.canManage ? (
        <Alert tone="info">
          Bu mülkü görüntülüyorsunuz; düzenleme yetkisi işletme sahibi ve yöneticilerdedir.
        </Alert>
      ) : null}

      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8">
        <PropertyForm
          action={updatePropertyAction.bind(null, p.id)}
          initial={toFormValues(p)}
          submitLabel="Değişiklikleri kaydet"
          pendingLabel="Kaydediliyor…"
          readOnly={!view.canManage}
        />
      </div>

      {view.canManage ? (
        <section
          aria-labelledby="durum-baslik"
          className="rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8"
        >
          <h2 id="durum-baslik" className="mb-3 text-base font-semibold text-navy-900">
            Durum
          </h2>
          <StatusToggle status={p.status} action={setPropertyStatusAction.bind(null, p.id)} />
        </section>
      ) : null}
    </div>
  );
}
