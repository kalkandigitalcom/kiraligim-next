import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, TextareaField } from "@/components/ui/field";
import { isAppError } from "@/lib/errors";
import { formatMinutes } from "@/lib/option-admin";
import { OPTION_LIMITS, OPTION_SETTINGS_LIMITS } from "@/lib/option-meta";
import {
  ADMIN_OPTION_ERRORS,
  type AdminOptionErrorCode,
  getOperation,
  getOperationRange,
  OPTION_CONVERT_ENABLED,
} from "@/server/admin/options";
import { requireAdmin } from "@/server/admin/session";

import { decideAction } from "../../actions";
import { fmt, guests, range } from "../../format";
import {
  END_REASON_LABELS,
  EXPIRY_SOURCE_LABELS,
  FAILURE_LABELS,
  NOTICES,
  OP_KIND_LABELS,
  OP_MODE_LABELS,
  OP_STATUS_LABELS,
  RANGE_KIND_LABELS,
  REASON_LABELS,
  RESERVATION_STATUS_LABELS,
  SOURCE_LABELS,
  STATUS_LABELS,
} from "../../labels";

export const metadata: Metadata = { title: "Opsiyon işlemi" };

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

/**
 * Onay ekranı: önerinin nedenleri, işlemin aralığındaki GÜNCEL takvim, onay / ret. Onay yalnız
 * işlemi "approved" yapar; uygulamayı bakım görevi, anahtarlar açıkken takvimi yeniden doğrulayarak
 * yapar. Kesin rezervasyona dönüştürme onayı Aşama 3e'ye kadar kapalıdır.
 */
export default async function AdminOptionOperationPage({ params, searchParams }: Props) {
  const admin = await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const { db } = admin.ctx;
  let op;
  try {
    op = await getOperation(db, admin.adminId, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const calendar = await getOperationRange(db, admin.adminId, op.id);
  const notice = NOTICES[one(sp.durum)];
  const code = one(sp.hata) as AdminOptionErrorCode;
  const error = code in ADMIN_OPTION_ERRORS ? ADMIN_OPTION_ERRORS[code] : null;
  const pending = op.status === "pending" && op.mode === "needs_approval";
  const convertLocked = op.kind === "convert" && !OPTION_CONVERT_ENABLED;
  const optionLink = op.targetOptionId ?? op.resultOptionId;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Link href="/opsiyonlar?sekme=onay" className="text-sm text-turquoise-700 hover:underline">
        ← Onay bekleyenler
      </Link>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-navy-900">
          {OP_KIND_LABELS[op.kind] ?? op.kind}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground" data-testid="admin-operation-status">
          {OP_STATUS_LABELS[op.status] ?? op.status} · {op.workspaceName} · {op.propertyName}
        </p>
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {op.calendarChanged ? (
        <Alert tone="error">
          Bu işlem kaydedildikten sonra villanın takvimi değişti. Aşağıdaki güncel takvimi kontrol
          edin; onaylarsanız karar bu andaki takvime göre verilir ve uygulama anında takvim yeniden
          değişmişse işlem uygulanmaz.
        </Alert>
      ) : null}

      <section className={CARD}>
        <dl className="flex flex-col gap-3">
          <Row label="Tarih">{range(op.checkIn, op.checkOut)}</Row>
          {op.kind === "create" ? (
            <Row label="Süre">
              {op.expiresInMinutes
                ? `${formatMinutes(op.expiresInMinutes)}${op.expirySource ? ` · ${EXPIRY_SOURCE_LABELS[op.expirySource] ?? op.expirySource}` : ""}`
                : "yazılmamış"}
            </Row>
          ) : null}
          {op.kind === "cancel" && op.endReason ? (
            <Row label="İptal nedeni">{END_REASON_LABELS[op.endReason] ?? op.endReason}</Row>
          ) : null}
          <Row label="Misafir">
            {op.guestName ? `${op.guestName} · ` : ""}
            {guests(op.adults, op.children)}
          </Row>
          <Row label="Onaya düşme nedeni">
            {op.reasons.length ? op.reasons.map((r) => REASON_LABELS[r] ?? r).join(", ") : "—"}
          </Row>
          <Row label="Kaynak">
            {SOURCE_LABELS[op.source] ?? op.source} · {OP_MODE_LABELS[op.mode] ?? op.mode}
            {op.groupSubject ? ` · grup: ${op.groupSubject}` : ""}
            {op.sentAt ? ` · mesaj ${fmt(op.sentAt)}` : ""}
          </Row>
          {op.targetOptionId ? (
            <Row label="Hedef opsiyon">
              <Link
                href={`/opsiyonlar/${op.targetOptionId}`}
                className="text-turquoise-700 hover:underline"
              >
                {op.targetStatus
                  ? (STATUS_LABELS[op.targetStatus] ?? op.targetStatus)
                  : "bulunamadı"}
                {op.targetVersion !== null ? ` · sürüm ${op.targetVersion}` : ""}
              </Link>
            </Row>
          ) : null}
          {op.decidedAt ? (
            <Row label="Karar">
              {fmt(op.decidedAt)}
              {op.decidedByName ? ` · ${op.decidedByName}` : ""}
              {op.decisionNote ? ` · “${op.decisionNote}”` : ""}
            </Row>
          ) : null}
          {op.appliedAt ? <Row label="Uygulandı">{fmt(op.appliedAt)}</Row> : null}
          {op.resultReservationId ? (
            <Row label="Kesin rezervasyon">
              <span className="font-mono text-sm">{op.resultReservationId}</span>
            </Row>
          ) : null}
          {op.failureCode ? (
            <Row label="Uygulanmama nedeni">{FAILURE_LABELS[op.failureCode] ?? op.failureCode}</Row>
          ) : null}
          {optionLink && op.resultOptionId ? (
            <Row label="Opsiyon">
              <Link
                href={`/opsiyonlar/${optionLink}`}
                className="text-turquoise-700 hover:underline"
              >
                Opsiyonu aç
              </Link>
            </Row>
          ) : null}
          <Row label="Kayıt">{fmt(op.createdAt)}</Row>
        </dl>
      </section>

      <section
        className={CARD}
        aria-labelledby="calendar-title"
        data-testid="admin-operation-calendar"
      >
        <div>
          <h2 id="calendar-title" className="font-semibold text-navy-900">
            Bu aralıkta güncel takvim
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Villanın {range(op.checkIn, op.checkOut)} aralığıyla kesişen kayıtları (şu an). Misafir
            bilgisi gösterilmez.
          </p>
        </div>
        {!op.checkIn ? (
          <p className="text-sm text-muted-foreground">İşlemde tarih yok.</p>
        ) : calendar.length === 0 ? (
          <p className="text-sm text-muted-foreground">Bu aralıkta başka kayıt yok.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border text-sm">
            {calendar.map((c) => (
              <li key={`${c.kind}-${c.refId}`} className="flex flex-wrap gap-x-3 px-4 py-2">
                <span className="font-medium text-navy-900">
                  {RANGE_KIND_LABELS[c.kind] ?? c.kind}
                </span>
                <span>{range(c.checkIn, c.checkOut)}</span>
                <span className="text-muted-foreground">
                  {c.kind === "option"
                    ? (SOURCE_LABELS[c.label] ?? c.label)
                    : (RESERVATION_STATUS_LABELS[c.status] ?? c.status)}
                  {c.kind === "external" && c.label ? ` · ${c.label}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {pending ? (
        <section
          className={CARD}
          aria-labelledby="decide-title"
          data-testid="admin-operation-decide"
        >
          <div>
            <h2 id="decide-title" className="font-semibold text-navy-900">
              Karar
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Onay işlemi uygulanmaya hazır hâle getirir. Bakım görevi yalnız global anahtar açıkken
              ve grup hâlâ bağlıyken uygular ve uygularken takvimi yeniden doğrular.
            </p>
          </div>
          {convertLocked ? (
            <Alert tone="info">
              Kesin rezervasyona dönüştürme Aşama 3e&apos;de açılacak. Bu işlemi şimdilik yalnız
              reddedebilirsiniz.
            </Alert>
          ) : null}
          {op.kind === "convert" && !convertLocked ? (
            <Alert tone="info">
              Onaylanırsa bakım görevi yaklaşık bir dakika içinde, işletme sahibi adına onaylı
              (kesin) bir rezervasyon oluşturur (kaynak: WhatsApp). Uygulama anında anahtarlar,
              takvim, opsiyonun durumu ve süresi yeniden denetlenir; çakışma, kapasite veya tarih
              sorunu varsa rezervasyon oluşturulmaz. Misafir adı, yetişkin ve çocuk sayısı (çocuk
              yoksa 0) zorunludur; boş alan doldurulmaz. Kesin rezervasyon API, iCal ve
              webhook&apos;a yansır.
            </Alert>
          ) : null}
          <form action={decideAction.bind(null, op.id)} className="flex flex-col gap-4">
            <input type="hidden" name="version" value={op.version} />
            {op.kind === "create" ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field
                  id="checkIn"
                  name="checkIn"
                  type="date"
                  label="Giriş"
                  defaultValue={op.checkIn ?? ""}
                />
                <Field
                  id="checkOut"
                  name="checkOut"
                  type="date"
                  label="Çıkış"
                  defaultValue={op.checkOut ?? ""}
                />
                <Field
                  id="duration"
                  name="duration"
                  label="Süre (saat veya 2g)"
                  placeholder={op.expiresInMinutes ? formatMinutes(op.expiresInMinutes) : "ör. 48"}
                  hint={op.expiresInMinutes ? "Boş bırakılırsa mevcut süre." : "Süre zorunlu."}
                  maxLength={8}
                />
              </div>
            ) : null}
            {op.kind === "convert" ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field
                  id="guestName"
                  name="guestName"
                  label="Misafir adı"
                  defaultValue={op.guestName ?? ""}
                  maxLength={OPTION_LIMITS.guestNameMax}
                  disabled={convertLocked}
                />
                <Field
                  id="adults"
                  name="adults"
                  inputMode="numeric"
                  label="Yetişkin"
                  defaultValue={op.adults ?? ""}
                  disabled={convertLocked}
                />
                <Field
                  id="children"
                  name="children"
                  inputMode="numeric"
                  label="Çocuk (yoksa 0)"
                  hint="Zorunlu; boş bırakılırsa onay verilmez."
                  defaultValue={op.children ?? ""}
                  disabled={convertLocked}
                />
              </div>
            ) : null}
            <TextareaField
              id="note"
              name="note"
              label="Not (isteğe bağlı)"
              maxLength={OPTION_SETTINGS_LIMITS.noteMax}
              rows={2}
            />
            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                name="decision"
                value="approve"
                disabled={convertLocked}
                aria-disabled={convertLocked}
                title={convertLocked ? "Aşama 3e'de açılacak" : undefined}
              >
                Onayla
              </Button>
              <Button type="submit" name="decision" value="reject" variant="secondary">
                Reddet
              </Button>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
}
