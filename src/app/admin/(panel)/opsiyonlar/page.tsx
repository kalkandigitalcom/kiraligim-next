import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatRemaining } from "@/lib/option-admin";
import { cn } from "@/lib/utils";
import {
  ADMIN_OPTION_ERRORS,
  type AdminOptionErrorCode,
  getOptionCounts,
  listAlerts,
  listOperations,
  listOptions,
} from "@/server/admin/options";
import { requireAdmin } from "@/server/admin/session";

import { acknowledgeAlertAction } from "./actions";
import { fmt, guests, range } from "./format";
import {
  ALERT_SOURCE_LABELS,
  badge,
  END_REASON_LABELS,
  NOTICES,
  OP_KIND_LABELS,
  type OptionTab,
  REASON_LABELS,
  RESERVATION_STATUS_LABELS,
  SOURCE_LABELS,
  TAB_LABELS,
  TAB_STATUS,
  TABS,
} from "./labels";

export const metadata: Metadata = { title: "Opsiyonlar" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

const CARD = "rounded-2xl border border-border bg-white shadow-sm";
const TH = "px-3 py-2 text-left font-medium";
const TD = "px-3 py-2 align-top";

/**
 * Super Admin — opsiyonlar. Onay bekleyen işlemler, durumlarına göre opsiyonlar ve çakışma
 * uyarıları. Opsiyon müsaitliği kapatmaz; rozetler (🟡 ✅ ❌) yalnız bu panelde görünür.
 */
export default async function AdminOptionsPage({ searchParams }: Props) {
  const admin = await requireAdmin();
  const { db } = admin.ctx;
  const sp = await searchParams;
  const tab: OptionTab = (TABS as readonly string[]).includes(one(sp.sekme))
    ? (one(sp.sekme) as OptionTab)
    : "onay";
  const status = TAB_STATUS[tab] ?? null;
  const [counts, operations, options, alerts] = await Promise.all([
    getOptionCounts(db, admin.adminId),
    tab === "onay" ? listOperations(db, admin.adminId, null) : Promise.resolve([]),
    status ? listOptions(db, admin.adminId, status) : Promise.resolve([]),
    tab === "uyarilar" ? listAlerts(db, admin.adminId) : Promise.resolve([]),
  ]);
  const notice = NOTICES[one(sp.durum)];
  const code = one(sp.hata) as AdminOptionErrorCode;
  const error = code in ADMIN_OPTION_ERRORS ? ADMIN_OPTION_ERRORS[code] : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-navy-900">Opsiyonlar</h1>
          <p className="mt-1 max-w-2xl text-[15px] text-muted-foreground">
            Kesinleşmemiş rezervasyonlar. Opsiyon takvimde müsaitliği kapatmaz; iCal, API ve
            webhook&apos;a yansımaz. Buradaki işlemler denetim kaydına yazılır.
          </p>
        </div>
        <Link
          href="/opsiyonlar/ayarlar"
          className="rounded-lg border border-border bg-white px-3 py-2 text-sm font-medium text-navy-900 hover:bg-mist"
        >
          Otomasyon ayarları
        </Link>
      </div>

      <p
        className={cn(
          "rounded-lg border px-4 py-3 text-sm",
          counts.globalEnabled
            ? "border-amber-300 bg-amber-50 text-amber-900"
            : "border-border bg-white text-navy-900",
        )}
        data-testid="admin-option-global"
      >
        Opsiyon otomasyonu (global):{" "}
        <strong>{counts.globalEnabled ? "AÇIK" : "KAPALI (kill switch)"}</strong>
        {counts.approvedWaiting > 0
          ? ` · ${counts.approvedWaiting} onaylı işlem uygulanmayı bekliyor${counts.globalEnabled ? "" : " (otomasyon kapalıyken uygulanmaz)"}`
          : ""}
      </p>

      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <nav aria-label="Opsiyon sekmeleri" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t}
            href={`/opsiyonlar?sekme=${t}`}
            aria-current={t === tab ? "page" : undefined}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm",
              t === tab
                ? "border-navy-900 bg-navy-900 text-white"
                : "border-border bg-white text-navy-900 hover:bg-mist",
            )}
          >
            {TAB_LABELS[t]}
            {t === "onay" ? ` (${counts.pendingApproval})` : ""}
            {t === "acik" ? ` (${counts.openOptions})` : ""}
            {t === "uyarilar" ? ` (${counts.openAlerts})` : ""}
          </Link>
        ))}
      </nav>

      {tab === "onay" ? (
        <section
          className={CARD}
          aria-label="Onay bekleyen işlemler"
          data-testid="admin-option-pending"
        >
          {operations.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">Onay bekleyen işlem yok.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className={TH}>İşlem</th>
                    <th className={TH}>İşletme / villa</th>
                    <th className={TH}>Tarih</th>
                    <th className={TH}>Neden</th>
                    <th className={TH}>Geldiği an</th>
                    <th className={TH} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {operations.map((op) => (
                    <tr key={op.id}>
                      <td className={TD}>
                        <span className="font-medium text-navy-900">{OP_KIND_LABELS[op.kind]}</span>
                        <span className="block text-muted-foreground">
                          {SOURCE_LABELS[op.source] ?? op.source}
                        </span>
                      </td>
                      <td className={TD}>
                        {op.workspaceName}
                        <span className="block text-muted-foreground">{op.propertyName}</span>
                      </td>
                      <td className={TD}>
                        {range(op.checkIn, op.checkOut)}
                        {op.calendarChanged ? (
                          <span className="block text-amber-700">takvim değişti</span>
                        ) : null}
                      </td>
                      <td className={TD}>
                        {op.reasons.map((r) => REASON_LABELS[r] ?? r).join(", ") || "—"}
                      </td>
                      <td className={TD}>{fmt(op.createdAt)}</td>
                      <td className={TD}>
                        <Link
                          href={`/opsiyonlar/islem/${op.id}`}
                          className="font-medium text-turquoise-700 hover:underline"
                        >
                          İncele
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {status ? (
        <section className={CARD} aria-label={TAB_LABELS[tab]} data-testid="admin-option-list">
          {options.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">Bu durumda opsiyon yok.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className={TH}>Durum</th>
                    <th className={TH}>İşletme / villa</th>
                    <th className={TH}>Giriş → çıkış</th>
                    <th className={TH}>Misafir</th>
                    <th className={TH}>{status === "open" ? "Kalan süre" : "Bitiş"}</th>
                    <th className={TH}>Kaynak</th>
                    <th className={TH} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {options.map((o) => (
                    <tr key={o.id}>
                      <td className={TD}>
                        {badge(o.status)}
                        {o.openAlerts > 0 ? (
                          <span className="block text-amber-700">{o.openAlerts} uyarı</span>
                        ) : null}
                      </td>
                      <td className={TD}>
                        {o.workspaceName}
                        <span className="block text-muted-foreground">{o.propertyName}</span>
                      </td>
                      <td className={TD}>{range(o.checkIn, o.checkOut)}</td>
                      <td className={TD}>{guests(o.adults, o.children)}</td>
                      <td className={TD}>
                        {status === "open"
                          ? o.expiresAt
                            ? formatRemaining(o.remainingSeconds)
                            : "süresiz"
                          : `${fmt(o.endedAt)}${o.endReason ? ` · ${END_REASON_LABELS[o.endReason] ?? o.endReason}` : ""}`}
                      </td>
                      <td className={TD}>{SOURCE_LABELS[o.source] ?? o.source}</td>
                      <td className={TD}>
                        <Link
                          href={`/opsiyonlar/${o.id}`}
                          className="font-medium text-turquoise-700 hover:underline"
                        >
                          Detay
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {tab === "uyarilar" ? (
        <section className={CARD} aria-label="Çakışma uyarıları" data-testid="admin-option-alerts">
          {alerts.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">Görülmemiş çakışma uyarısı yok.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {alerts.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-col gap-2 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="min-w-0">
                    <span className="block font-medium text-navy-900">
                      {a.workspaceName} · {a.propertyName}
                    </span>
                    <span className="block text-muted-foreground">
                      Opsiyon {badge(a.optionStatus)} {range(a.optionCheckIn, a.optionCheckOut)} ↔{" "}
                      {ALERT_SOURCE_LABELS[a.sourceKind]}
                      {a.sourceLabel ? ` (${a.sourceLabel})` : ""}{" "}
                      {range(a.sourceCheckIn, a.sourceCheckOut)}
                      {a.sourceStatus
                        ? ` · ${RESERVATION_STATUS_LABELS[a.sourceStatus] ?? a.sourceStatus}`
                        : ""}{" "}
                      · tespit {fmt(a.detectedAt)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <Link
                      href={`/opsiyonlar/${a.optionId}`}
                      className="font-medium text-turquoise-700 hover:underline"
                    >
                      Opsiyon
                    </Link>
                    <form
                      action={acknowledgeAlertAction.bind(null, a.id, "/opsiyonlar?sekme=uyarilar")}
                    >
                      <Button type="submit" variant="secondary" size="sm">
                        Görüldü
                      </Button>
                    </form>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Liste en fazla 200 kayıt gösterir. Saatler İstanbul saatidir; kalan süre sayfa açıldığı anda
        hesaplanır.
      </p>
    </div>
  );
}
