import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { isAppError } from "@/lib/errors";
import { formatStay, RESERVATION_STATUS_LABELS } from "@/lib/reservation-meta";
import { listPropertyOptions } from "@/server/whatsapp/service";
import {
  approvalDefaults,
  canDecideProposals,
  getProposal,
  proposalConflicts,
  WA_APPLICABLE_ACTIONS,
} from "@/server/whatsapp/proposals";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { ApproveForm, RejectForm } from "../decision-forms";
import { ACTION_LABELS, FLAG_LABELS, REASON_LABELS, ROLE_LABELS, STATUS_LABELS } from "../labels";

export const metadata: Metadata = { title: "WhatsApp önerisi" };

type Props = { params: Promise<{ id: string }> };

const TIME_FMT = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  dateStyle: "short",
  timeStyle: "short",
});

const RESOLUTION_LABELS = {
  named: "mesajda adıyla",
  single: "grubun villası",
  ambiguous: "birden çok aday",
  none: "belirlenemedi",
} as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="text-sm text-muted-foreground sm:w-40 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 text-[15px] break-words text-navy-900">{children}</dd>
    </div>
  );
}

/**
 * Tek öneri: mesaj alıntısı, ayrıştırma sonucu, inceleme nedenleri, takvim çakışmaları ve karar
 * formları. Çakışma burada yalnız bilgi içindir; onay anında sunucu ve veritabanı yeniden denetler.
 */
export default async function WhatsAppProposalPage({ params }: Props) {
  const { id } = await params;
  const view = await withPanelTenant(async (tx, ctx) => {
    if (!canDecideProposals(ctx)) return { allowed: false as const };
    try {
      const p = await getProposal(tx, ctx, id);
      return {
        allowed: true as const,
        p,
        conflicts: await proposalConflicts(tx, p.propertyId, p.checkIn, p.checkOut),
        properties: await listPropertyOptions(tx),
      };
    } catch (err) {
      if (isAppError(err) && err.code === "NOT_FOUND") return null;
      throw err;
    }
  });
  if (view === null) notFound();

  if (!view.allowed) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <Alert tone="info">Önerileri yalnız işletme sahibi ve yöneticiler görebilir.</Alert>
      </div>
    );
  }

  const { p, conflicts, properties } = view;
  const applicable =
    p.status === "pending" &&
    p.action !== null &&
    (WA_APPLICABLE_ACTIONS as readonly string[]).includes(p.action);
  const hasConflict = conflicts.internal.length > 0 || conflicts.external.length > 0;
  const propertyOptions = properties.map((o) => ({
    value: o.id,
    label: o.active ? o.name : `${o.name} (pasif)`,
  }));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Link href="/whatsapp/oneriler" className="text-sm text-turquoise-700 hover:underline">
        ← Öneriler
      </Link>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-navy-900">
          {p.action ? ACTION_LABELS[p.action] : "Belirsiz işlem"} önerisi
        </h1>
        <p className="mt-1 text-sm text-muted-foreground" data-testid="wa-proposal-status">
          {STATUS_LABELS[p.status]}
          {p.decidedAt ? ` · ${TIME_FMT.format(p.decidedAt)}` : ""}
        </p>
      </div>

      <section className="flex flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6">
        <blockquote
          className="rounded-lg bg-mist px-4 py-3 text-[15px] whitespace-pre-wrap text-navy-900"
          data-testid="wa-proposal-excerpt"
        >
          {p.excerpt}
        </blockquote>
        <dl className="flex flex-col gap-3">
          <Row label="Grup">{p.groupSubject ?? "—"}</Row>
          <Row label="Gönderen">{ROLE_LABELS[p.senderRole] ?? p.senderRole}</Row>
          <Row label="Gönderim">{TIME_FMT.format(p.sentAt)}</Row>
          <Row label="Villa">
            {p.propertyName ?? (p.villaNameRaw ? `“${p.villaNameRaw}”` : "—")}{" "}
            <span className="text-sm text-muted-foreground">
              ({RESOLUTION_LABELS[p.villaResolution]})
            </span>
            {p.candidates.length > 1 ? (
              <span className="block text-sm text-muted-foreground">
                Adaylar: {p.candidates.map((c) => c.name).join(", ")}
              </span>
            ) : null}
          </Row>
          <Row label="Tarih">
            {p.checkIn && p.checkOut ? formatStay(p.checkIn, p.checkOut) : "Belirsiz"}
          </Row>
          {p.action === "reserve" ? (
            <Row label="Kişi">
              {p.guests.total !== null
                ? `${p.guests.total}${p.guests.children ? ` (${p.guests.children} çocuk)` : ""}`
                : "Mesajda yok"}
            </Row>
          ) : null}
          {p.reservationStatus ? (
            <Row label="Durum">{RESERVATION_STATUS_LABELS[p.reservationStatus]}</Row>
          ) : null}
          {p.reviewReasons.length > 0 ? (
            <Row label="İnceleme nedeni">
              {p.reviewReasons.map((r) => REASON_LABELS[r] ?? r).join(", ")}
            </Row>
          ) : null}
          {p.flags.length > 0 ? (
            <Row label="Ayrıştırma notları">
              {p.flags.map((f) => FLAG_LABELS[f] ?? f).join(", ")}
            </Row>
          ) : null}
          {p.decisionNote ? <Row label="Karar notu">{p.decisionNote}</Row> : null}
        </dl>
        {p.appliedReservationIds[0] ? (
          <Link
            href={`/rezervasyonlar/${p.appliedReservationIds[0]}`}
            className="text-sm text-turquoise-700 hover:underline"
          >
            Oluşturulan kayda git →
          </Link>
        ) : null}
      </section>

      {p.status === "pending" ? (
        <>
          {hasConflict ? (
            <Alert tone="error" title="Takvimde çakışma var">
              <span data-testid="wa-proposal-conflicts">
                {conflicts.internal.map((c) => (
                  <Link
                    key={c.id}
                    href={`/rezervasyonlar/${c.id}`}
                    className="block underline-offset-4 hover:underline"
                  >
                    {c.kind === "block" ? "Kapalı" : "Rezervasyon"} ·{" "}
                    {formatStay(c.checkIn, c.checkOut)}
                  </Link>
                ))}
                {conflicts.external.map((c, i) => (
                  <span key={`x${i}`} className="block">
                    {c.sourceName} · {formatStay(c.checkIn, c.checkOut)}
                  </span>
                ))}
                Onaylamadan önce tarihleri veya villayı düzeltin ya da öneriyi reddedin.
              </span>
            </Alert>
          ) : null}

          {applicable ? (
            <section className="flex flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6">
              <h2 className="font-semibold text-navy-900">Onayla</h2>
              <ApproveForm
                id={p.id}
                version={p.version}
                action={p.action as "reserve" | "close"}
                defaults={approvalDefaults(p)}
                properties={propertyOptions}
              />
            </section>
          ) : (
            <Alert tone="info">
              Bu öneri türü panelden henüz uygulanamıyor. Gerekirse takvimde elle işleyip öneriyi
              reddedin.
            </Alert>
          )}

          <section className="flex flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6">
            <h2 className="font-semibold text-navy-900">Reddet</h2>
            <RejectForm id={p.id} version={p.version} />
          </section>
        </>
      ) : null}
    </div>
  );
}
