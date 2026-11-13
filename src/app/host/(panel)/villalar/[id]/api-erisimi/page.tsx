import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { listPropertyApiConnections, listPropertyApiGrants } from "@/server/api/grants";
import { getProperty } from "@/server/properties/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { StatusBadge } from "../../_components/property-bits";
import { PropertyTabs } from "../../_components/property-tabs";

export const metadata: Metadata = { title: "API erişimi" };

type Props = { params: Promise<{ id: string }> };

const DATE = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Istanbul",
});

/**
 * Villa sayfası — API erişimi (1. aşama). Acenteler bu villanın yalnız adını ve dolu tarihlerini
 * okuyabilir. İzinleri yalnız Kiraligim ekibi (Super Admin) ekler ve kaldırır; bu sayfa salt
 * okunurdur. Tüm üyeler erişimi olan acenteleri ve takvim bağlantılarını görür.
 */
/** Acentenin bu villa için takvim bağlantısı (2. aşama): bağlı / duraklatıldı / yok. */
function ConnectionNote({
  connection: c,
}: {
  connection: { paused: boolean; createdAt: Date; lastSyncedAt: Date | null } | undefined;
}) {
  if (!c) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="api-connection">
        Takvim bağlantısı yok.
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground" data-testid="api-connection">
      {c.paused ? "Takvim bağlı (duraklatıldı)" : "Takvim bağlı"} · {DATE.format(c.createdAt)}
      {c.lastSyncedAt ? ` · son senkron ${DATE.format(c.lastSyncedAt)}` : ""}
    </p>
  );
}

export default async function PropertyApiAccessPage({ params }: Props) {
  const { id } = await params;
  const view = await withPanelTenant(async (tx) => {
    const property = await getProperty(tx, id);
    if (!property) return null;
    return {
      property,
      grants: await listPropertyApiGrants(tx, property.id),
      connections: await listPropertyApiConnections(tx, property.id),
    };
  });
  if (!view) notFound();
  const { property: p, grants, connections } = view;

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
          <p className="mt-1 text-[15px] text-muted-foreground">API erişimi</p>
        </div>
        <StatusBadge status={p.status} />
      </div>
      <PropertyTabs propertyId={p.id} active="api" />

      <Alert tone="info">
        Acente erişimlerini Kiraligim ekibi yönetir. Bir izin eklenmesini veya kaldırılmasını
        istiyorsanız Kiraligim ekibiyle iletişime geçin.
      </Alert>

      <section
        aria-labelledby="api-grants-title"
        className="flex flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
      >
        <div>
          <h2 id="api-grants-title" className="font-semibold text-navy-900">
            Erişimi olan acenteler{" "}
            <span className="font-normal text-muted-foreground">({grants.length})</span>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Acenteler bu villanın yalnız adını ve dolu tarihlerini görebilir. Fiyat, misafir
            bilgisi, açıklama, fotoğraf, adres ve rezervasyon ayrıntısı paylaşılmaz. Villa pasif
            olduğunda acenteler villayı göremez ve takvim bağlantısı duraklatılır. Erişim
            kaldırıldığında takvim bağlantısı da sona erer.
          </p>
        </div>
        {grants.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-white/60 px-5 py-8 text-center">
            <p className="font-semibold text-navy-900">Henüz erişimi olan acente yok.</p>
          </div>
        ) : (
          <ul
            className="flex flex-col divide-y divide-border rounded-xl border border-border"
            aria-label="Erişimi olan acenteler"
            data-testid="api-grants"
          >
            {grants.map((g) => (
              <li
                key={g.id}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="font-semibold break-words text-navy-900">{g.clientName}</p>
                  <p className="text-sm text-muted-foreground">
                    {DATE.format(g.createdAt)} ·{" "}
                    {g.grantedVia === "owner" ? "Kodla onaylandı" : "Platform tarafından eklendi"}
                  </p>
                  <ConnectionNote connection={connections.find((c) => c.grantId === g.id)} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
