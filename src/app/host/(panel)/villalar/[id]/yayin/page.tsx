import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { getEnv } from "@/lib/env";
import {
  formatWhatsapp,
  PUBLISH_REQUIREMENT_LABELS,
  PUBLISH_REQUIREMENTS,
  publicVillaUrl,
  shareMessage,
} from "@/lib/public-profile-meta";
import { cn } from "@/lib/utils";
import { stepHref } from "@/lib/property-wizard";
import { getPublicProfile } from "@/server/properties/public-profile";
import { canManageProperties } from "@/server/properties/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { StatusBadge } from "../../_components/property-bits";
import { PropertyTabs } from "../../_components/property-tabs";
import { publishAction, unpublishAction, updatePublicSlugAction } from "./actions";
import { PublishControls } from "./publish-controls";
import { ShareLink } from "./share-link";
import { SlugForm } from "./slug-form";

export const metadata: Metadata = { title: "Yayın" };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

const NOTICES: Record<string, string> = {
  kaydedildi: "Villa sayfası ayarları kaydedildi.",
  "degisiklik-yok": "Değişiklik yapılmadı.",
  yayinlandi: "Sayfa yayınlandı.",
  kaldirildi: "Sayfa yayından kaldırıldı; bağlantı müşteriler için açılmaz.",
};

const STATE_BADGE = {
  published: { label: "Yayında", className: "bg-turquoise-50 text-turquoise-700" },
  draft: { label: "Taslak", className: "bg-muted text-muted-foreground" },
  closed: { label: "Kapalı", className: "bg-amber-50 text-amber-900" },
} as const;

/**
 * Yayın ayarları: YALNIZ müşteriye açık sayfanın yayınıyla ilgili alanlar — sayfa adresi, yayın
 * durumu ve eksik koşullar, önizleme, yayınla/yayından kaldır, müşteri bağlantısı ve paylaşım,
 * WhatsApp numarası bağlantısı. Olanaklar ve konaklama bilgileri mülk bilgileridir (Bilgiler).
 * Tüm üyeler görür ve bağlantıyı paylaşabilir; owner/manager adresi değiştirir, yayınlar ve
 * önizler (yetki sunucuda denetlenir). WhatsApp numarası işletme düzeyindedir (yalnız owner,
 * Genel Bakış → Müşteri iletişimi).
 */
export default async function PropertyPublishPage({ params, searchParams }: Props) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const view = await withPanelTenant(async (tx, ctx) => ({
    profile: await getPublicProfile(tx, id),
    canManage: canManageProperties(ctx.role),
    isOwner: ctx.role === "owner",
  }));
  const p = view.profile;
  if (!p) notFound();
  const { canManage, isOwner } = view;
  const env = getEnv();
  const publicHost = new URL(env.PUBLIC_URL).host;
  const url = p.publicSlug ? publicVillaUrl(env.PUBLIC_URL, p.publicSlug) : null;
  const notice = NOTICES[one(sp.durum) ?? ""];
  const vis = p.visibility;
  const unmet = vis.state === "published" ? [] : vis.unmet;
  const badge = STATE_BADGE[vis.state];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Link href="/villalar" className="text-sm font-medium text-turquoise-700 hover:underline">
        ← Mülkler
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">
            {p.propertyName}
          </h1>
          <p className="mt-1 text-[15px] text-muted-foreground">Yayın</p>
        </div>
        <StatusBadge status={p.propertyStatus} />
      </div>
      <PropertyTabs propertyId={p.propertyId} active="publish" />

      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {!canManage ? (
        <Alert tone="info">
          Yayın durumunu görüntüleyebilir ve bağlantıyı paylaşabilirsiniz; adres değiştirme ve
          yayınlama yetkisi işletme sahibi ve yöneticilerdedir.
        </Alert>
      ) : null}

      {/* Durum */}
      <section
        aria-labelledby="publish-state-title"
        className="flex flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="publish-state-title" className="font-semibold text-navy-900">
            Yayın durumu
          </h2>
          <span
            data-testid="publish-state"
            className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", badge.className)}
          >
            {badge.label}
          </span>
        </div>
        {vis.state === "closed" ? (
          <p className="text-sm text-amber-900" data-testid="closed-reason">
            Sayfa yayında görünüyor ancak şu koşul sağlanmadığı için müşterilere kapalı:{" "}
            {vis.unmet
              .map((r) => PUBLISH_REQUIREMENT_LABELS[r].toLocaleLowerCase("tr-TR"))
              .join(", ")}
            .
          </p>
        ) : null}
        <ul className="grid gap-2 text-sm sm:grid-cols-2" aria-label="Yayın koşulları">
          {PUBLISH_REQUIREMENTS.map((r) => {
            const okR = !unmet.includes(r);
            return (
              <li key={r} className="flex items-start gap-2" data-testid={`req-${r}`} data-ok={okR}>
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                    okR ? "bg-turquoise-50 text-turquoise-700" : "bg-amber-50 text-amber-900",
                  )}
                >
                  {okR ? "✓" : "!"}
                </span>
                <span className="text-navy-900">
                  {PUBLISH_REQUIREMENT_LABELS[r]}
                  <span className="sr-only">{okR ? " (tamam)" : " (eksik)"}</span>
                  {!okR && r === "photo" ? (
                    <Link
                      href={stepHref(p.propertyId, "aciklama")}
                      className="ml-1 text-turquoise-700 hover:underline"
                    >
                      Fotoğraf ekle
                    </Link>
                  ) : null}
                  {!okR && r === "whatsapp" ? (
                    isOwner ? (
                      <Link
                        href="/panel#iletisim"
                        className="ml-1 text-turquoise-700 hover:underline"
                      >
                        Numara ekle
                      </Link>
                    ) : (
                      <span className="ml-1 text-muted-foreground">(işletme sahibi ekler)</span>
                    )
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="text-sm text-muted-foreground">
          WhatsApp numarası:{" "}
          <span className="font-medium text-navy-900">
            {p.whatsapp ? formatWhatsapp(p.whatsapp) : "tanımlı değil"}
          </span>
          {isOwner ? (
            <>
              {" · "}
              <Link href="/panel#iletisim" className="text-turquoise-700 hover:underline">
                Değiştir
              </Link>
            </>
          ) : null}
        </p>
        {canManage ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <Link
              href={`/villalar/${p.propertyId}/yayin/onizleme`}
              target="_blank"
              className={buttonVariants({ size: "sm", variant: "secondary" })}
              data-testid="preview-link"
            >
              Sayfayı önizle
              <span className="sr-only"> (yeni sekmede açılır)</span>
            </Link>
            <span className="text-sm text-muted-foreground">
              Müşterinin göreceği sayfa; yayında olmasa da yalnız size görünür.
            </span>
          </div>
        ) : null}
        {canManage ? (
          <PublishControls
            isPublic={p.isPublic}
            canPublish={unmet.length === 0}
            publish={publishAction.bind(null, p.propertyId)}
            unpublish={unpublishAction.bind(null, p.propertyId)}
          />
        ) : null}
      </section>

      {/* Bağlantı */}
      <section
        aria-labelledby="publish-link-title"
        className="flex flex-col gap-3 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
      >
        <h2 id="publish-link-title" className="font-semibold text-navy-900">
          Bağlantı
        </h2>
        {url ? (
          <ShareLink url={url} message={shareMessage(p.propertyName, url)} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Bağlantı oluşturmak için önce aşağıdan sayfa adresini kaydedin.
          </p>
        )}
      </section>

      {/* Sayfa adresi */}
      <section
        id="sayfa-adresi"
        aria-labelledby="publish-slug-title"
        className="rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
      >
        <h2 id="publish-slug-title" className="mb-4 font-semibold text-navy-900">
          Sayfa adresi
        </h2>
        {canManage ? (
          <SlugForm
            action={updatePublicSlugAction.bind(null, p.propertyId)}
            initial={{ publicSlug: p.publicSlug ?? "", confirmSlugChange: false }}
            savedSlug={p.publicSlug}
            isPublic={p.isPublic}
            propertyName={p.propertyName}
            district={p.district}
            publicHost={publicHost}
          />
        ) : (
          <p className="text-sm text-navy-900" data-testid="slug-readonly">
            {p.publicSlug ? `${publicHost}/villa/${p.publicSlug}` : "Henüz adres kaydedilmedi."}
          </p>
        )}
        <p className="mt-4 border-t border-border pt-4 text-sm text-muted-foreground">
          Olanaklar, giriş-çıkış saatleri ve kurallar mülk bilgilerindedir.{" "}
          <Link
            href={stepHref(p.propertyId, "olanaklar")}
            className="font-medium text-turquoise-700 hover:underline"
          >
            Bilgilere git
          </Link>
        </p>
      </section>
    </div>
  );
}
