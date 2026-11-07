import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getDb } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { isAppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/session";
import { resolveActiveWorkspace } from "@/server/workspaces/active";
import { listWorkspaceMembers } from "@/server/workspaces/service";

export const metadata: Metadata = { title: "Panel" };

const ROLE_LABEL = { owner: "Sahip", manager: "Yönetici", staff: "Personel" } as const;

const UPCOMING = [
  { title: "Villalar", text: "Mülklerinizi ve özelliklerini ekleyin." },
  { title: "Rezervasyonlar", text: "Rezervasyonları tek listede takip edin." },
  { title: "Takvim", text: "Doluluk ve müsaitlik görünümü." },
] as const;

export default async function PanelPage() {
  const user = await requireUser();
  const active = await resolveActiveWorkspace(user.id);
  if (active.kind === "none") redirect("/isletme-olustur");
  if (active.kind === "choose" || active.kind === "suspended") redirect("/isletmeler");

  // Tenant bağlamı oturumdaki kullanıcı kimliğiyle kurulur; withTenant üyeliği ve aktif durumu
  // veritabanında yeniden doğrular (çerezdeki seçim tek başına yetki vermez).
  let view;
  try {
    view = await withTenant(
      getDb(),
      { userId: user.id, workspaceId: active.workspace.id },
      async (tx, ctx) => ({ role: ctx.role, memberCount: (await listWorkspaceMembers(tx)).length }),
    );
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") redirect("/");
    throw err;
  }

  const firstName = user.name.split(/\s+/)[0] ?? user.name;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="text-sm font-medium text-turquoise-700">{active.workspace.name}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">
          Hoş geldiniz, {firstName}
        </h1>
      </div>

      <section
        aria-labelledby="isletme-baslik"
        className="rounded-2xl border border-border bg-white p-6 shadow-sm"
      >
        <h2 id="isletme-baslik" className="text-base font-semibold text-navy-900">
          İşletme bilgileri
        </h2>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">İşletme adı</dt>
            <dd className="mt-1 font-medium text-navy-900">{active.workspace.name}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Kısa adres</dt>
            <dd className="mt-1 font-medium text-navy-900">{active.workspace.slug}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Rolünüz</dt>
            <dd className="mt-1 font-medium text-navy-900">
              {ROLE_LABEL[view.role]} · {view.memberCount} üye
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="yakinda-baslik">
        <h2 id="yakinda-baslik" className="text-base font-semibold text-navy-900">
          Yakında
        </h2>
        <ul className="mt-4 grid gap-4 sm:grid-cols-3">
          {UPCOMING.map((m) => (
            <li
              key={m.title}
              className="rounded-2xl border border-dashed border-border bg-white/60 p-5"
            >
              <p className="font-semibold text-navy-900">{m.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{m.text}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
