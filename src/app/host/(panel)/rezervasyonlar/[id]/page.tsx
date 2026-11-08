import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import {
  formatStay,
  RESERVATION_KIND_LABELS,
  RESERVATION_SOURCE_LABELS,
  requestReference,
} from "@/lib/reservation-meta";
import { canManageReservations, getReservation } from "@/server/reservations/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { cancelReservationAction, confirmReservationAction } from "../actions";
import { Money, ReservationStatusBadge } from "../_components/reservation-bits";
import { CancelPanel, ConfirmButton } from "../_components/status-actions";

export const metadata: Metadata = { title: "Rezervasyon" };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const NOTICES: Record<string, string> = {
  olusturuldu: "Kayıt oluşturuldu.",
  guncellendi: "Değişiklikler kaydedildi.",
  "degisiklik-yok": "Değişiklik yapılmadı.",
  onaylandi: "Rezervasyon onaylandı.",
  iptal: "Kayıt iptal edildi; tarihler yeniden müsait.",
};

const dateTime = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Istanbul",
});

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="text-sm text-muted-foreground sm:w-40 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 text-[15px] break-words text-navy-900">{children}</dd>
    </div>
  );
}

export default async function ReservationPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { durum } = await searchParams;
  // RLS: başka işletmenin kaydı veya geçersiz kimlik → null → 404 (varlık sızdırılmaz).
  const view = await withPanelTenant(async (tx, ctx) => ({
    r: await getReservation(tx, id),
    canManage: canManageReservations(ctx.role),
  }));
  const r = view.r;
  if (!r) notFound();
  const isBlock = r.kind === "block";
  const active = r.status !== "cancelled";
  const notice = typeof durum === "string" ? NOTICES[durum] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Link
        href="/rezervasyonlar"
        className="text-sm font-medium text-turquoise-700 hover:underline"
      >
        ← Rezervasyonlar
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-turquoise-700">
            {RESERVATION_KIND_LABELS[r.kind]} · {r.propertyName}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight break-words text-navy-900 sm:text-3xl">
            {isBlock ? "Kapalı tarihler" : r.guestName}
          </h1>
          <p className="mt-1 text-[15px] text-navy-900">
            {formatStay(r.checkIn, r.checkOut)} · {r.nights} gece
          </p>
        </div>
        <ReservationStatusBadge status={r.status} kind={r.kind} />
      </div>

      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {!view.canManage && active ? (
        <Alert tone="info">
          Bu kaydı görüntülüyorsunuz; düzenleme ve iptal yetkisi işletme sahibi ve yöneticilerdedir.
        </Alert>
      ) : null}

      <section
        aria-labelledby="bilgi-baslik"
        className="rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8"
      >
        <h2 id="bilgi-baslik" className="mb-4 text-base font-semibold text-navy-900">
          {isBlock ? "Blok bilgileri" : "Rezervasyon bilgileri"}
        </h2>
        <dl className="flex flex-col gap-3">
          <Row label="Mülk">{r.propertyName}</Row>
          <Row label={isBlock ? "Tarihler" : "Giriş – çıkış"}>
            {formatStay(r.checkIn, r.checkOut)} ({r.nights} gece)
          </Row>
          {isBlock ? null : (
            <>
              <Row label="Misafir">{r.guestName}</Row>
              <Row label="Telefon">
                {r.guestPhone ? (
                  <a
                    href={`tel:${r.guestPhone.replace(/[^0-9+]/g, "")}`}
                    className="text-turquoise-700 hover:underline"
                  >
                    {r.guestPhone}
                  </a>
                ) : (
                  "—"
                )}
              </Row>
              <Row label="E-posta">
                {r.guestEmail ? (
                  <a href={`mailto:${r.guestEmail}`} className="text-turquoise-700 hover:underline">
                    {r.guestEmail}
                  </a>
                ) : (
                  "—"
                )}
              </Row>
              <Row label="Kişi">
                {r.adults} yetişkin{r.children ? `, ${r.children} çocuk` : ""}
              </Row>
              <Row label="Kaynak">{r.source ? RESERVATION_SOURCE_LABELS[r.source] : "—"}</Row>
              {r.source === "web" ? (
                <Row label="Talep no">
                  <span data-testid="request-reference">{requestReference(r.id)}</span>
                  {r.status === "pending" ? (
                    <span className="block text-sm text-muted-foreground">
                      Villa sayfasından gelen talep. Onaylayana kadar kesin değildir; tarihler bu
                      sürede kapalı görünür.
                    </span>
                  ) : null}
                </Row>
              ) : null}
            </>
          )}
          <Row label={isBlock ? "Açıklama" : "Not"}>
            {r.note ? <span className="whitespace-pre-line">{r.note}</span> : "—"}
          </Row>
          <Row label="Oluşturulma">{dateTime.format(r.createdAt)}</Row>
          {r.status === "cancelled" && r.cancelledAt ? (
            <>
              <Row label="İptal">{dateTime.format(r.cancelledAt)}</Row>
              {r.cancelReason ? <Row label="İptal nedeni">{r.cancelReason}</Row> : null}
            </>
          ) : null}
        </dl>
      </section>

      {isBlock ? null : (
        <section
          aria-labelledby="odeme-baslik"
          className="rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8"
        >
          <h2 id="odeme-baslik" className="mb-4 text-base font-semibold text-navy-900">
            Ödeme
          </h2>
          {r.totalAmountMinor === null ? (
            <p className="text-sm text-muted-foreground">Tutar girilmemiş.</p>
          ) : (
            <dl className="grid gap-4 sm:grid-cols-3" data-testid="amounts">
              <div>
                <dt className="text-sm text-muted-foreground">Toplam</dt>
                <dd className="mt-1 text-lg font-semibold text-navy-900">
                  <Money minor={r.totalAmountMinor} currency={r.currency} />
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Ön ödeme</dt>
                <dd className="mt-1 text-lg font-semibold text-navy-900">
                  <Money minor={r.depositAmountMinor ?? 0} currency={r.currency} />
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Kalan</dt>
                <dd className="mt-1 text-lg font-semibold text-navy-900">
                  <Money minor={r.balanceAmountMinor} currency={r.currency} />
                </dd>
              </div>
            </dl>
          )}
        </section>
      )}

      {view.canManage && active ? (
        <section
          aria-labelledby="islem-baslik"
          className="flex flex-col gap-4 rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8"
        >
          <h2 id="islem-baslik" className="text-base font-semibold text-navy-900">
            İşlemler
          </h2>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {r.status === "pending" ? (
              <ConfirmButton action={confirmReservationAction.bind(null, r.id)} />
            ) : null}
            <Link
              href={`/rezervasyonlar/${r.id}/duzenle`}
              className={buttonVariants({ variant: "secondary", className: "w-full sm:w-auto" })}
            >
              Düzenle
            </Link>
          </div>
          <div className="border-t border-border pt-4">
            <CancelPanel action={cancelReservationAction.bind(null, r.id)} kind={r.kind} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
