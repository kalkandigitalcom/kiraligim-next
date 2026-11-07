import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-meta";
import { ALLOWANCE_MESSAGES } from "@/server/billing/entitlements";
import { canManageProperties, getPropertyUsage, listProperties } from "@/server/properties/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { StatusBadge, UsageMeter } from "./_components/property-bits";

export const metadata: Metadata = { title: "Mülkler" };

export default async function PropertiesPage() {
  const view = await withPanelTenant(async (tx, ctx) => ({
    properties: await listProperties(tx),
    usage: await getPropertyUsage(tx),
    canManage: canManageProperties(ctx.role),
  }));
  const { properties, usage, canManage } = view;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">Mülkler</h1>
          <p className="mt-1 text-[15px] text-muted-foreground">
            Villa, apart, bungalow ve evlerinizi buradan yönetin.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:items-end">
          <UsageMeter usage={usage} />
          {canManage && usage.allowed ? (
            <Link href="/villalar/yeni" className={buttonVariants({ className: "sm:self-end" })}>
              Yeni mülk
            </Link>
          ) : null}
        </div>
      </div>

      {canManage && !usage.allowed ? (
        <Alert tone="info">
          {ALLOWANCE_MESSAGES[usage.reason]}
          {usage.reason === "limit_reached"
            ? " Mevcut mülklerinizi düzenleyebilir veya pasife alabilirsiniz; pasif mülkler de pakete dahildir."
            : null}
        </Alert>
      ) : null}
      {!canManage ? (
        <Alert tone="info">
          Mülkleri görüntüleyebilirsiniz; ekleme ve düzenleme yetkisi işletme sahibi ve
          yöneticilerdedir.
        </Alert>
      ) : null}

      {properties.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-white/60 px-6 py-12 text-center">
          <p className="font-semibold text-navy-900">Henüz mülk eklenmedi</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {canManage && usage.allowed
              ? "İlk mülkünüzü ekleyerek başlayın."
              : "Eklenen mülkler burada listelenir."}
          </p>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {properties.map((p) => (
            <li key={p.id}>
              <Link
                href={`/villalar/${p.id}`}
                className="flex h-full flex-col gap-3 rounded-2xl border border-border bg-white p-5 shadow-sm transition-colors hover:border-turquoise-500 focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-navy-900">{p.name}</p>
                    <p className="mt-0.5 truncate text-sm text-muted-foreground">
                      {PROPERTY_TYPE_LABELS[p.propertyType]} · {p.district}, {p.province}
                    </p>
                  </div>
                  <StatusBadge status={p.status} />
                </div>
                <p className="text-sm text-navy-900">
                  {p.maxGuests} kişi · {p.bedrooms} yatak odası · {p.bathrooms} banyo
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
