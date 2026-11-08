import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { getEnv } from "@/lib/env";
import {
  formatSyncTime,
  ICAL_ERROR_MESSAGES,
  ICAL_LIMITS,
  ICAL_SOURCE_STATUS_LABELS,
  ICAL_SYNC_INTERVAL_HOURS,
  icalExportUrl,
  type IcalSourceStatus,
} from "@/lib/ical-meta";
import { cn } from "@/lib/utils";
import { canManageIcal, ensureExport, listRecentRuns, listSources } from "@/server/ical/service";
import { getProperty } from "@/server/properties/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { StatusBadge } from "../../_components/property-bits";
import { PropertyTabs } from "../../_components/property-tabs";
import {
  addSourceAction,
  deleteSourceAction,
  rotateExportAction,
  syncSourceAction,
  toggleSourceAction,
  updateSourceAction,
} from "./actions";
import { ExportLink, SourceControls, SourceForm } from "./ical-components";

export const metadata: Metadata = { title: "Takvim bağlantıları" };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

const NOTICES: Record<string, { tone: "success" | "info" | "error"; text: string }> = {
  eklendi: { tone: "success", text: "Harici takvim eklendi." },
  "eklendi-senkron": { tone: "success", text: "Harici takvim eklendi ve senkron edildi." },
  "eklendi-hata": {
    tone: "info",
    text: "Harici takvim eklendi ancak ilk senkron başarısız oldu; ayrıntı aşağıda.",
  },
  guncellendi: { tone: "success", text: "Harici takvim güncellendi." },
  "degisiklik-yok": { tone: "info", text: "Değişiklik yapılmadı." },
  etkinlestirildi: {
    tone: "success",
    text: "Takvim etkinleştirildi; bir sonraki senkronda güncellenir.",
  },
  pasiflestirildi: {
    tone: "success",
    text: "Takvim pasifleştirildi; tarihleri artık müsaitliği etkilemez.",
  },
  silindi: {
    tone: "success",
    text: "Harici takvim ve ondan gelen doluluklar silindi. Diğer takvimler etkilenmedi.",
  },
  "senkron-tamam": { tone: "success", text: "Senkron tamamlandı." },
  "senkron-hata": { tone: "error", text: "Senkron başarısız oldu; ayrıntı aşağıda." },
  "senkron-suruyor": {
    tone: "info",
    text: "Bu takvim için senkron zaten sürüyor; biraz sonra yenileyin.",
  },
  "senkron-bekle": {
    tone: "info",
    text: "Az önce senkron edildi; bir dakika sonra tekrar deneyin.",
  },
  "senkron-pasif": { tone: "info", text: "Pasif takvim senkron edilmez; önce etkinleştirin." },
  "baglanti-yenilendi": {
    tone: "success",
    text: "Yeni dışa aktarma bağlantısı oluşturuldu. Eski adres artık çalışmaz; platformlara yeni adresi ekleyin.",
  },
};

const STATUS_BADGE: Record<IcalSourceStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  ok: "bg-turquoise-50 text-turquoise-700",
  error: "bg-destructive/10 text-destructive",
};

/**
 * Harici takvimler (iCal, Aşama 3.1). Tüm üyeler kaynakları ve durumlarını görür (adresler
 * gizli); owner/manager ekler, düzenler (?duzenle=<id>), etkinleştirir/pasifleştirir, elle senkron
 * eder, siler ve mülkün dışa aktarma bağlantısını görür/yeniler. Yetki sunucuda ve veritabanında
 * denetlenir; harici doluluklar rezervasyon olarak kaydedilmez.
 */
export default async function PropertyIcalPage({ params, searchParams }: Props) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const view = await withPanelTenant(async (tx, ctx) => {
    const property = await getProperty(tx, id);
    if (!property) return null;
    return {
      property,
      sources: await listSources(tx, ctx, property.id),
      runs: await listRecentRuns(tx, property.id),
      exportInfo: await ensureExport(tx, ctx, property.id),
      canManage: canManageIcal(ctx.role),
    };
  });
  if (!view) notFound();
  const { property: p, sources, runs, exportInfo, canManage } = view;
  const editing = canManage ? sources.find((s) => s.id === one(sp.duzenle)) : undefined;
  const notice = NOTICES[one(sp.durum) ?? ""];
  const base = `/villalar/${p.id}/takvim-baglantilari`;
  const exportUrl = exportInfo ? icalExportUrl(getEnv().APP_URL, exportInfo.token) : null;
  const full = sources.length >= ICAL_LIMITS.sourcesPerProperty;

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
          <p className="mt-1 text-[15px] text-muted-foreground">Takvim bağlantıları (iCal)</p>
        </div>
        <StatusBadge status={p.status} />
      </div>
      <PropertyTabs propertyId={p.id} active="ical" />

      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      {!canManage ? (
        <Alert tone="info">
          Harici takvimleri ve durumlarını görüntüleyebilirsiniz; takvim ekleme, senkron ve dışa
          aktarma bağlantısı işletme sahibi ve yöneticilerdedir.
        </Alert>
      ) : null}

      {/* ── İçe aktarma ── */}
      <section
        aria-labelledby="ical-import-title"
        className="flex flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
      >
        <div>
          <h2 id="ical-import-title" className="font-semibold text-navy-900">
            Harici Takvimler (iCal){" "}
            <span className="font-normal text-muted-foreground">({sources.length})</span>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Airbnb, Booking.com ve diğer platformlardaki dolu tarihler takviminize aktarılır ve bu
            tarihlere rezervasyon veya blok eklenemez. Etkin takvimler yaklaşık{" "}
            {ICAL_SYNC_INTERVAL_HOURS} saatte bir otomatik senkron edilir. Harici doluluklar
            rezervasyon olarak kaydedilmez; takvimde ayrı (mor) renkte görünür.
          </p>
        </div>

        {sources.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-white/60 px-5 py-8 text-center">
            <p className="font-semibold text-navy-900">Henüz harici takvim yok.</p>
            {canManage ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Aşağıdaki formla platformun iCal (.ics) bağlantısını ekleyin.
              </p>
            ) : null}
          </div>
        ) : (
          <ul
            className="flex flex-col gap-3"
            aria-label="Harici takvimler"
            data-testid="ical-sources"
          >
            {sources.map((s) => {
              const lastRun = runs.find((r) => r.sourceId === s.id);
              return (
                <li
                  key={s.id}
                  data-testid="ical-source"
                  data-status={s.status}
                  data-active={s.isActive ? "true" : "false"}
                  className={cn(
                    "flex flex-col gap-3 rounded-xl border px-4 py-3.5",
                    s.isActive ? "border-border" : "border-dashed border-border bg-mist/60",
                    editing?.id === s.id && "ring-2 ring-turquoise-500",
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-navy-900">
                        {s.name}
                        {!s.isActive ? (
                          <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            Pasif
                          </span>
                        ) : null}
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {s.maskedUrl}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold",
                        STATUS_BADGE[s.status],
                      )}
                    >
                      {s.syncing ? "Senkron sürüyor" : ICAL_SOURCE_STATUS_LABELS[s.status]}
                    </span>
                  </div>
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                    <div className="flex gap-1.5">
                      <dt className="text-muted-foreground">Son senkron:</dt>
                      <dd className="text-navy-900">{formatSyncTime(s.lastSyncedAt)}</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="text-muted-foreground">Son başarılı:</dt>
                      <dd className="text-navy-900" data-testid="ical-last-success">
                        {formatSyncTime(s.lastSuccessAt)}
                      </dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="text-muted-foreground">Dolu aralık:</dt>
                      <dd className="text-navy-900" data-testid="ical-event-count">
                        {s.eventCount}
                      </dd>
                    </div>
                    {lastRun?.outcome === "ok" ? (
                      <div className="flex gap-1.5">
                        <dt className="text-muted-foreground">Son değişiklik:</dt>
                        <dd className="text-navy-900">
                          +{lastRun.added} yeni · {lastRun.updated} güncel · −{lastRun.deactivated}{" "}
                          kalktı
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                  {s.status === "error" && s.lastErrorCode ? (
                    <Alert tone="error">
                      {ICAL_ERROR_MESSAGES[s.lastErrorCode]}
                      {s.consecutiveFailures > 1
                        ? ` (${s.consecutiveFailures} denemedir başarısız; son başarılı senkronun tarihleri korunuyor.)`
                        : " Son başarılı senkronun tarihleri korunuyor."}
                    </Alert>
                  ) : null}
                  {s.conflictCount > 0 ? (
                    <Alert tone="info">
                      Bu takvimden gelen {s.conflictCount} doluluk Kiraligim&apos;deki bir
                      rezervasyon veya blokla çakışıyor. Takvimde kontrol edin (çift rezervasyon
                      riski).
                    </Alert>
                  ) : null}
                  {canManage ? (
                    <SourceControls
                      name={s.name}
                      isActive={s.isActive}
                      editHref={`${base}?duzenle=${s.id}#takvim-formu`}
                      syncAction={syncSourceAction.bind(null, s.id, p.id)}
                      toggleAction={toggleSourceAction.bind(null, s.id, p.id, !s.isActive)}
                      deleteAction={deleteSourceAction.bind(null, s.id, p.id)}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {canManage ? (
          <div id="takvim-formu" className="border-t border-border pt-4">
            <h3 className="mb-3 font-semibold text-navy-900">
              {editing ? `Takvimi düzenle: ${editing.name}` : "Yeni harici takvim"}
            </h3>
            {!editing && full ? (
              <Alert tone="info">
                Bir mülke en fazla {ICAL_LIMITS.sourcesPerProperty} harici takvim eklenebilir.
              </Alert>
            ) : (
              <SourceForm
                key={editing?.id ?? `new:${one(sp.durum) ?? ""}`}
                mode={editing ? "edit" : "create"}
                action={
                  editing
                    ? updateSourceAction.bind(null, editing.id, p.id)
                    : addSourceAction.bind(null, p.id)
                }
                initial={
                  editing
                    ? { name: editing.name, url: editing.url ?? "", isActive: editing.isActive }
                    : { name: "", url: "", isActive: true }
                }
                cancelHref={editing ? base : undefined}
              />
            )}
          </div>
        ) : null}
      </section>

      {/* ── Dışa aktarma ── */}
      <section
        aria-labelledby="ical-export-title"
        className="flex flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
      >
        <div>
          <h2 id="ical-export-title" className="font-semibold text-navy-900">
            iCal bağlantımı dışa aktar
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Bu adresi Airbnb, Booking.com veya diğer platformlara &quot;takvim içe aktar&quot;
            olarak ekleyin. Kiraligim&apos;deki rezervasyonlarınız ve bloklarınız orada dolu
            görünür. Misafir adı, telefon veya tutar paylaşılmaz; harici takvimlerden gelen
            doluluklar geri gönderilmez. Platformlar bu adresi kendi aralıklarında okur (anlık
            değildir).
          </p>
        </div>
        {exportUrl && exportInfo ? (
          <>
            <ExportLink url={exportUrl} rotateAction={rotateExportAction.bind(null, p.id)} />
            <p className="text-sm text-muted-foreground">
              Son okunma: {formatSyncTime(exportInfo.lastFetchedAt)}
              {exportInfo.rotatedAt
                ? ` · Bağlantı en son ${formatSyncTime(exportInfo.rotatedAt)} tarihinde yenilendi.`
                : ""}
            </p>
            <p className="text-sm text-muted-foreground">
              Adres bir erişim anahtarıdır: yalnız takvim eklediğiniz platformlarla paylaşın. Yanlış
              kişiyle paylaşıldıysa &quot;Bağlantıyı yenile&quot; ile eskisini geçersiz kılın.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Dışa aktarma bağlantısını işletme sahibi ve yöneticiler görebilir.
          </p>
        )}
      </section>
    </div>
  );
}
