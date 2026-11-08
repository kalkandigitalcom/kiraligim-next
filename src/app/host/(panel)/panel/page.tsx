import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getDb } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { isAppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/session";
import { formatWhatsapp } from "@/lib/public-profile-meta";
import { getEntitlements } from "@/server/billing/entitlements";
import { getPropertyUsage } from "@/server/properties/service";
import { resolveActiveWorkspace } from "@/server/workspaces/active";
import { getWorkspaceWhatsapp } from "@/server/workspaces/contact";
import { listWorkspaceMembers } from "@/server/workspaces/service";

import { updateWhatsappAction } from "./actions";
import { WhatsappForm } from "./whatsapp-form";

export const metadata: Metadata = { title: "Panel" };

const dateTr = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Istanbul",
});

const ROLE_LABEL = { owner: "Sahip", manager: "Yönetici", staff: "Personel" } as const;

const UPCOMING = [
  { title: "Rezervasyonlar", text: "Rezervasyonları tek listede takip edin." },
  { title: "Takvim", text: "Doluluk ve müsaitlik görünümü." },
] as const;

const CONTACT_NOTICES: Record<string, string> = {
  kaydedildi: "WhatsApp numarası kaydedildi.",
  "degisiklik-yok": "Değişiklik yapılmadı.",
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function PanelPage({ searchParams }: Props) {
  const sp = await searchParams;
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
      async (tx, ctx) => ({
        role: ctx.role,
        memberCount: (await listWorkspaceMembers(tx)).length,
        plan: await getEntitlements(tx),
        usage: await getPropertyUsage(tx),
        whatsapp: await getWorkspaceWhatsapp(tx),
      }),
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

      <section
        id="iletisim"
        aria-labelledby="iletisim-baslik"
        className="scroll-mt-24 rounded-2xl border border-border bg-white p-6 shadow-sm"
      >
        <h2 id="iletisim-baslik" className="text-base font-semibold text-navy-900">
          Müşteri iletişimi
        </h2>
        {typeof sp.iletisim === "string" && CONTACT_NOTICES[sp.iletisim] ? (
          <p
            role="status"
            className="mt-3 rounded-lg bg-turquoise-50 px-4 py-2 text-sm text-turquoise-700"
          >
            {CONTACT_NOTICES[sp.iletisim]}
          </p>
        ) : null}
        <div className="mt-4">
          {view.role === "owner" ? (
            <WhatsappForm action={updateWhatsappAction} initial={view.whatsapp ?? ""} />
          ) : (
            <dl className="text-sm">
              <dt className="text-muted-foreground">WhatsApp numarası</dt>
              <dd className="mt-1 font-medium text-navy-900" data-testid="whatsapp-readonly">
                {view.whatsapp ? formatWhatsapp(view.whatsapp) : "Tanımlı değil"}
              </dd>
              <dd className="mt-1 text-muted-foreground">
                Numarayı işletme sahibi değiştirebilir.
              </dd>
            </dl>
          )}
        </div>
      </section>

      <section
        aria-labelledby="paket-baslik"
        className="rounded-2xl border border-border bg-white p-6 shadow-sm"
      >
        <h2 id="paket-baslik" className="text-base font-semibold text-navy-900">
          Paket
        </h2>
        {view.plan ? (
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Paket</dt>
              <dd className="mt-1 font-medium text-navy-900">{view.plan.planName}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Mülk hakkı</dt>
              <dd className="mt-1 font-medium text-navy-900">{view.plan.maxProperties}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Durum</dt>
              <dd className="mt-1 font-medium text-navy-900">
                {view.plan.effectiveStatus === "trialing" && view.plan.trialEndsAt
                  ? `Ücretsiz deneme · ${view.plan.trialDaysLeft} gün kaldı (${dateTr.format(view.plan.trialEndsAt)})`
                  : view.plan.effectiveStatus === "active"
                    ? "Aktif"
                    : view.plan.effectiveStatus === "canceled"
                      ? "İptal edildi"
                      : "Süresi doldu"}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            İşletmeniz için tanımlı bir paket bulunamadı.
          </p>
        )}
        {view.plan && !view.plan.isCurrent ? (
          <p className="mt-4 rounded-lg bg-mist px-4 py-3 text-sm text-navy-900">
            {view.plan.effectiveStatus === "canceled"
              ? "Aboneliğiniz iptal edildi."
              : "Deneme süreniz sona erdi."}{" "}
            Mevcut mülklerinizi görüntüleyip düzenleyebilirsiniz; yeni mülk ekleyemezsiniz.
          </p>
        ) : null}
      </section>

      <Link
        href="/villalar"
        className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-white p-6 shadow-sm transition-colors hover:border-turquoise-500 focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
      >
        <span>
          <span className="block text-base font-semibold text-navy-900">Mülkler</span>
          <span className="mt-1 block text-sm text-muted-foreground">
            {view.usage.used} / {view.usage.limit} mülk · Mülklerinizi görüntüleyin ve yönetin
          </span>
        </span>
        <span aria-hidden className="text-lg text-turquoise-700">
          →
        </span>
      </Link>

      <section aria-labelledby="yakinda-baslik">
        <h2 id="yakinda-baslik" className="text-base font-semibold text-navy-900">
          Yakında
        </h2>
        <ul className="mt-4 grid gap-4 sm:grid-cols-2">
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
