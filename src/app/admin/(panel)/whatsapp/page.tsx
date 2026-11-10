import type { Metadata } from "next";
import Link from "next/link";

import { cn } from "@/lib/utils";
import { requireAdmin } from "@/server/admin/session";
import {
  type AdminGroupTab,
  groupTab,
  listAdminConnections,
  listAdminGroups,
} from "@/server/admin/whatsapp";

import { ago, fmt } from "./format";
import { CONNECTION_LABELS, STATUS_LABELS, TAB_LABELS } from "./labels";

export const metadata: Metadata = { title: "WhatsApp grupları" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const TABS = Object.keys(TAB_LABELS) as AdminGroupTab[];

/**
 * Super Admin — WhatsApp grupları. Gateway'in keşfettiği tüm gruplar; eşleştirme, aktif/pasif,
 * villa değişikliği ve bağlantı kaldırma yalnız burada (grup detayı) yapılır.
 */
export default async function AdminWhatsAppPage({ searchParams }: Props) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const tab: AdminGroupTab =
    typeof sp.sekme === "string" && (TABS as string[]).includes(sp.sekme)
      ? (sp.sekme as AdminGroupTab)
      : "bekleyen";
  const [groups, connections] = await Promise.all([
    listAdminGroups(admin.ctx.db, admin.adminId),
    listAdminConnections(admin.ctx.db, admin.adminId),
  ]);
  const counts = Object.fromEntries(TABS.map((t) => [t, 0])) as Record<AdminGroupTab, number>;
  for (const g of groups) {
    const t = groupTab(g);
    if (t) counts[t] += 1;
    counts.tum += 1;
  }
  const shown = tab === "tum" ? groups : groups.filter((g) => groupTab(g) === tab);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-navy-900">WhatsApp grupları</h1>
        <p className="mt-1 text-[15px] text-muted-foreground">
          Kiralığım asistanının eklendiği gruplar. Bir grup ancak burada bir işletmeye ve o
          işletmenin villasına eşleştirildiğinde mesajları işlenir.
        </p>
      </div>

      <section
        aria-label="Gateway bağlantısı"
        className="flex flex-col gap-2 rounded-2xl border border-border bg-white p-5 shadow-sm"
        data-testid="admin-wa-connections"
      >
        <h2 className="font-semibold text-navy-900">Gateway bağlantısı</h2>
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">Henüz bağlantı kaydı yok.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {connections.map((c) => (
              <li key={c.id} className="flex flex-wrap gap-x-3">
                <span className="font-medium text-navy-900">{c.label}</span>
                <span>{CONNECTION_LABELS[c.status] ?? c.status}</span>
                <span className="text-muted-foreground">son görülme {ago(c.lastSeenAt)}</span>
                {c.lastErrorCode ? (
                  <span className="text-muted-foreground">son kod {c.lastErrorCode}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <nav aria-label="Grup durumu" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t}
            href={`/whatsapp?sekme=${t}`}
            aria-current={t === tab ? "page" : undefined}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm font-medium",
              t === tab
                ? "border-navy-900 bg-navy-900 text-white"
                : "border-border bg-white text-navy-900 hover:bg-mist",
            )}
          >
            {TAB_LABELS[t]} <span className="opacity-70">({counts[t]})</span>
          </Link>
        ))}
      </nav>

      <section
        className="rounded-2xl border border-border bg-white shadow-sm"
        data-testid="admin-wa-groups"
      >
        {shown.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">Bu listede grup yok.</p>
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((g) => (
              <li key={g.id}>
                <Link
                  href={`/whatsapp/${g.id}`}
                  className="flex flex-col gap-1 px-5 py-3 hover:bg-mist/60 sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-navy-900">
                      {g.subject ?? "(adsız grup)"}
                    </span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {g.jid}
                    </span>
                  </span>
                  <span className="flex flex-col text-sm sm:items-end">
                    <span className="text-navy-900">
                      {g.workspaceName
                        ? `${g.workspaceName} · ${g.propertyName ?? "villa yok"}`
                        : (STATUS_LABELS[g.status] ?? g.status)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      keşif {fmt(g.firstSeenAt)} · son mesaj {ago(g.lastMessageAt)}
                      {g.sameJidCount > 1 ? " · mükerrer kayıt" : ""}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
