import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextareaField } from "@/components/ui/field";
import { isAppError } from "@/lib/errors";
import { formatRemaining } from "@/lib/option-admin";
import { OPTION_SETTINGS_LIMITS } from "@/lib/option-meta";
import {
  ADMIN_OPTION_ERRORS,
  type AdminOptionErrorCode,
  getOption,
  listAlerts,
  listOptionEvents,
  listOptionOperations,
} from "@/server/admin/options";
import { requireAdmin } from "@/server/admin/session";

import { acknowledgeAlertAction, cancelOptionAction } from "../actions";
import { fmt, guests, range } from "../format";
import {
  ALERT_SOURCE_LABELS,
  badge,
  END_REASON_LABELS,
  EVENT_LABELS,
  EXPIRY_SOURCE_LABELS,
  FAILURE_LABELS,
  NOTICES,
  OP_KIND_LABELS,
  OP_STATUS_LABELS,
  RESERVATION_STATUS_LABELS,
  SOURCE_LABELS,
  STATUS_LABELS,
} from "../labels";

export const metadata: Metadata = { title: "Opsiyon" };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

const CARD = "flex flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="text-sm text-muted-foreground sm:w-44 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 text-[15px] break-words text-navy-900">{children}</dd>
    </div>
  );
}

/** Opsiyon detayı: durum, süre, geçmiş, bağlı işlemler, çakışma uyarıları, panelden iptal. */
export default async function AdminOptionPage({ params, searchParams }: Props) {
  const admin = await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const { db } = admin.ctx;
  let o;
  try {
    o = await getOption(db, admin.adminId, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const [events, operations, alerts] = await Promise.all([
    listOptionEvents(db, admin.adminId, o.id),
    listOptionOperations(db, admin.adminId, o.id),
    listAlerts(db, admin.adminId, { optionId: o.id, includeAcknowledged: true }),
  ]);
  const notice = NOTICES[one(sp.durum)];
  const code = one(sp.hata) as AdminOptionErrorCode;
  const error = code in ADMIN_OPTION_ERRORS ? ADMIN_OPTION_ERRORS[code] : null;
  const open = o.status === "open";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Link href="/opsiyonlar?sekme=acik" className="text-sm text-turquoise-700 hover:underline">
        ← Opsiyonlar
      </Link>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-navy-900">
          {o.propertyName} · {range(o.checkIn, o.checkOut)}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground" data-testid="admin-option-status">
          {badge(o.status)} · {o.workspaceName}
        </p>
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <section className={CARD}>
        <dl className="flex flex-col gap-3">
          <Row label="Durum">{STATUS_LABELS[o.status] ?? o.status}</Row>
          <Row label="Giriş → çıkış">{range(o.checkIn, o.checkOut)}</Row>
          <Row label="Misafir">
            {o.guestName ? `${o.guestName} · ` : ""}
            {guests(o.adults, o.children)}
          </Row>
          <Row label="Süre">
            {o.expiresAt
              ? `${fmt(o.expiresAt)}${open ? ` (kalan ${formatRemaining(o.remainingSeconds)})` : ""}${o.expirySource ? ` · ${EXPIRY_SOURCE_LABELS[o.expirySource] ?? o.expirySource}` : ""}`
              : "süresiz"}
          </Row>
          <Row label="Kaynak">
            {SOURCE_LABELS[o.source] ?? o.source}
            {o.groupSubject ? ` · grup: ${o.groupSubject}` : ""}
            {o.byMessage ? " · mesajdan" : ""}
          </Row>
          <Row label="Oluşturulma">{fmt(o.createdAt)}</Row>
          {o.endedAt ? (
            <Row label="Bitiş">
              {fmt(o.endedAt)}
              {o.endReason ? ` · ${END_REASON_LABELS[o.endReason] ?? o.endReason}` : ""}
            </Row>
          ) : null}
          {o.convertedReservationId ? (
            <Row label="Kesin rezervasyon">
              <span className="font-mono text-sm">{o.convertedReservationId}</span>
            </Row>
          ) : null}
          <Row label="Sürüm">{o.version}</Row>
        </dl>
        <p className="text-sm text-muted-foreground">
          Opsiyon takvimde müsaitliği kapatmaz; iCal, API ve webhook&apos;a yansımaz.
        </p>
      </section>

      <section className={CARD} aria-labelledby="alerts-title" data-testid="admin-option-alerts">
        <h2 id="alerts-title" className="font-semibold text-navy-900">
          Çakışma uyarıları
        </h2>
        {alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">Çakışma uyarısı yok.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {alerts.map((a) => (
              <li
                key={a.id}
                className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0">
                  <span className="block font-medium text-navy-900">
                    {ALERT_SOURCE_LABELS[a.sourceKind]}
                    {a.sourceLabel ? ` (${a.sourceLabel})` : ""} ·{" "}
                    {range(a.sourceCheckIn, a.sourceCheckOut)}
                  </span>
                  <span className="block text-muted-foreground">
                    {a.sourceStatus
                      ? `${RESERVATION_STATUS_LABELS[a.sourceStatus] ?? a.sourceStatus} · `
                      : ""}
                    tespit {fmt(a.detectedAt)}
                    {a.acknowledgedAt
                      ? ` · görüldü ${fmt(a.acknowledgedAt)}${a.acknowledgedByName ? ` (${a.acknowledgedByName})` : ""}`
                      : ""}
                  </span>
                </span>
                {a.acknowledgedAt ? null : (
                  <form action={acknowledgeAlertAction.bind(null, a.id, `/opsiyonlar/${o.id}`)}>
                    <Button type="submit" variant="secondary" size="sm">
                      Görüldü
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={CARD} aria-labelledby="ops-title" data-testid="admin-option-operations">
        <h2 id="ops-title" className="font-semibold text-navy-900">
          Bağlı işlemler
        </h2>
        {operations.length === 0 ? (
          <p className="text-sm text-muted-foreground">Bağlı işlem yok.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {operations.map((op) => (
              <li key={op.id} className="flex flex-col gap-0.5 px-4 py-3 text-sm">
                <Link
                  href={`/opsiyonlar/islem/${op.id}`}
                  className="font-medium text-turquoise-700 hover:underline"
                >
                  {OP_KIND_LABELS[op.kind] ?? op.kind}
                </Link>
                <span className="text-muted-foreground">
                  {OP_STATUS_LABELS[op.status] ?? op.status} ·{" "}
                  {SOURCE_LABELS[op.source] ?? op.source} · {fmt(op.createdAt)}
                  {op.failureCode ? ` · ${FAILURE_LABELS[op.failureCode] ?? op.failureCode}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={CARD} aria-labelledby="history-title" data-testid="admin-option-history">
        <h2 id="history-title" className="font-semibold text-navy-900">
          İşlem geçmişi
        </h2>
        <ol className="flex flex-col gap-2 text-sm">
          {events.map((e) => (
            <li key={`${e.version}-${e.event}`} className="flex flex-wrap gap-x-3">
              <span className="font-medium text-navy-900">{EVENT_LABELS[e.event] ?? e.event}</span>
              <span className="text-muted-foreground">
                {fmt(e.createdAt)} · sürüm {e.version}
                {e.reason ? ` · ${END_REASON_LABELS[e.reason] ?? e.reason}` : ""}
                {e.byAdmin ? " · Super Admin" : e.byMessage ? " · WhatsApp mesajı" : " · sistem"}
              </span>
            </li>
          ))}
        </ol>
      </section>

      {open ? (
        <section className={CARD} aria-labelledby="cancel-title" data-testid="admin-option-cancel">
          <div>
            <h2 id="cancel-title" className="font-semibold text-navy-900">
              Panelden iptal
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Yalnız bu opsiyon iptal edilir (neden: panelden iptal). Kesin rezervasyon, blok ve
              takvime dokunulmaz; WhatsApp&apos;a mesaj veya tepki gönderilmez.
            </p>
          </div>
          <form action={cancelOptionAction.bind(null, o.id)} className="flex flex-col gap-3">
            <input type="hidden" name="version" value={o.version} />
            <TextareaField
              id="note"
              name="note"
              label="Not (isteğe bağlı)"
              maxLength={OPTION_SETTINGS_LIMITS.noteMax}
              rows={2}
            />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="confirm" value="evet" required /> Bu opsiyonun iptal
              edilmesini onaylıyorum.
            </label>
            <div>
              <Button type="submit" variant="secondary">
                Opsiyonu iptal et
              </Button>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
}
