import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { canManageApiAccess, listPropertyApiGrants } from "@/server/api/grants";
import { getProperty } from "@/server/properties/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { StatusBadge } from "../../_components/property-bits";
import { PropertyTabs } from "../../_components/property-tabs";
import { confirmGrantAction, lookupCodeAction, revokeGrantAction } from "./actions";
import { GrantFlow, RevokeButton } from "./api-access-components";

export const metadata: Metadata = { title: "API erişimi" };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

const NOTICES: Record<string, { tone: "success" | "info"; text: string }> = {
  verildi: { tone: "success", text: "Acenteye bu villa için erişim verildi." },
  "zaten-var": { tone: "info", text: "Bu acentenin bu villaya zaten erişimi var." },
  kaldirildi: {
    tone: "success",
    text: "Erişim kaldırıldı. Acente bu villanın bilgilerini artık göremez.",
  },
};

const DATE = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Istanbul",
});

/**
 * Villa sayfası — API erişimi (1. aşama). Acenteler bu villanın yalnız adını ve dolu tarihlerini
 * okuyabilir. Tüm üyeler erişimi olan acenteleri görür; kod girme, onay ve kaldırma işletme sahibi
 * ve yöneticilerdedir (sunucuda ve veritabanında yeniden denetlenir).
 */
export default async function PropertyApiAccessPage({ params, searchParams }: Props) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const view = await withPanelTenant(async (tx, ctx) => {
    const property = await getProperty(tx, id);
    if (!property) return null;
    return {
      property,
      grants: await listPropertyApiGrants(tx, property.id),
      canManage: canManageApiAccess(ctx.role),
    };
  });
  if (!view) notFound();
  const { property: p, grants, canManage } = view;
  const notice = NOTICES[one(sp.durum) ?? ""];

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

      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      {!canManage ? (
        <Alert tone="info">
          Erişimi olan acenteleri görüntüleyebilirsiniz; erişim verme ve kaldırma işletme sahibi ve
          yöneticilerdedir.
        </Alert>
      ) : null}

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
            olduğunda acenteler villayı göremez.
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
                </div>
                {canManage ? (
                  <RevokeButton
                    clientName={g.clientName}
                    action={revokeGrantAction.bind(null, g.id, p.id)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManage ? (
        <section
          aria-labelledby="api-grant-title"
          className="flex flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
        >
          <div>
            <h2 id="api-grant-title" className="font-semibold text-navy-900">
              Acenteye erişim ver
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Acentenin size verdiği erişim kodunu girin. Acentenin adını görüp onayladığınızda
              erişim başlar.
            </p>
          </div>
          <GrantFlow
            lookup={lookupCodeAction.bind(null, p.id)}
            confirm={confirmGrantAction.bind(null, p.id)}
          />
        </section>
      ) : null}
    </div>
  );
}
