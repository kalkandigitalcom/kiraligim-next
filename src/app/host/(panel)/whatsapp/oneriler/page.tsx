import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { formatStay } from "@/lib/reservation-meta";
import { cn } from "@/lib/utils";
import {
  canDecideProposals,
  listProposals,
  type WaProposalView,
} from "@/server/whatsapp/proposals";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { ACTION_LABELS, AUTO_FAILURE_LABELS, REASON_LABELS, STATUS_LABELS } from "./labels";

export const metadata: Metadata = { title: "WhatsApp önerileri" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const NOTICES: Record<string, { tone: "success" | "info"; text: string }> = {
  reddedildi: { tone: "success", text: "Öneri reddedildi; takvim değişmedi." },
};

const TIME_FMT = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  dateStyle: "short",
  timeStyle: "short",
});

function stay(p: WaProposalView) {
  return p.checkIn && p.checkOut ? formatStay(p.checkIn, p.checkOut) : "Tarih belirsiz";
}

function villa(p: WaProposalView) {
  if (p.propertyName) return p.propertyName;
  if (p.candidates.length > 1) return `${p.candidates.length} aday villa`;
  return p.villaNameRaw ? `“${p.villaNameRaw}” (eşleşmedi)` : "Villa belirsiz";
}

/**
 * WhatsApp Asistanı — A2d: worker'ın ürettiği takvim önerileri. Hiçbir öneri kendiliğinden
 * takvime yazılmaz; owner/manager inceler, onaylar veya reddeder.
 */
export default async function WhatsAppProposalsPage({ searchParams }: Props) {
  const sp = await searchParams;
  const view = await withPanelTenant(async (tx, ctx) => {
    if (!canDecideProposals(ctx)) return null;
    return {
      pending: await listProposals(tx, ctx, "pending"),
      decided: await listProposals(tx, ctx, "decided", 20),
    };
  });
  const notice = NOTICES[typeof sp.durum === "string" ? sp.durum : ""];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <Link href="/whatsapp" className="text-sm text-turquoise-700 hover:underline">
        ← WhatsApp Asistanı
      </Link>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">
          WhatsApp önerileri
        </h1>
        <p className="mt-1 text-[15px] text-muted-foreground">
          Bağlı gruplara yazılan rezervasyon ve kapatma mesajlarından çıkarılan öneriler.
          Rezervasyonlar yalnız siz onayladığınızda oluşur. İşletme sahibinin grubun villası için
          yazdığı net tarihli ve çakışmasız kapatma talimatı ise takvime otomatik işlenir.
        </p>
      </div>

      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}

      {!view ? (
        <Alert tone="info">Önerileri yalnız işletme sahibi ve yöneticiler görebilir.</Alert>
      ) : (
        <>
          <section
            aria-labelledby="wa-prop-pending"
            className="flex flex-col gap-3 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
            data-testid="wa-proposals-pending"
          >
            <h2 id="wa-prop-pending" className="font-semibold text-navy-900">
              Onay bekleyenler{" "}
              <span className="font-normal text-muted-foreground">({view.pending.length})</span>
            </h2>
            {view.pending.length === 0 ? (
              <p className="text-sm text-muted-foreground">Bekleyen öneri yok.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {view.pending.map((p) => (
                  <li key={p.id} className="py-3">
                    <Link
                      href={`/whatsapp/oneriler/${p.id}`}
                      className="flex flex-col gap-1 rounded-lg hover:bg-mist/60 sm:px-2"
                    >
                      <span className="flex flex-wrap items-baseline gap-x-2 font-medium text-navy-900">
                        {p.action ? ACTION_LABELS[p.action] : "Belirsiz işlem"} · {villa(p)} ·{" "}
                        {stay(p)}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {p.groupSubject ?? "Grup"} · {TIME_FMT.format(p.sentAt)}
                        {p.reviewReasons.length > 0
                          ? ` · ${p.reviewReasons.map((r) => REASON_LABELS[r] ?? r).join(", ")}`
                          : ""}
                      </span>
                      {p.autoFailure ? (
                        <span className="text-sm text-amber-800" data-testid="wa-auto-failed">
                          Otomatik kapatma uygulanamadı:{" "}
                          {AUTO_FAILURE_LABELS[p.autoFailure] ?? p.autoFailure}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section
            aria-labelledby="wa-prop-decided"
            className="flex flex-col gap-3 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
          >
            <h2 id="wa-prop-decided" className="font-semibold text-navy-900">
              Son kararlar
            </h2>
            {view.decided.length === 0 ? (
              <p className="text-sm text-muted-foreground">Henüz karar yok.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border text-sm">
                {view.decided.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-baseline gap-x-2 py-2">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium",
                        p.status === "applied"
                          ? "bg-turquoise-50 text-turquoise-700"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {p.decisionMode === "quick" ? "Otomatik uygulandı" : STATUS_LABELS[p.status]}
                    </span>
                    <span className="text-navy-900">
                      {p.action ? ACTION_LABELS[p.action] : "Belirsiz işlem"} · {villa(p)} ·{" "}
                      {stay(p)}
                    </span>
                    {p.appliedReservationIds[0] ? (
                      <Link
                        href={`/rezervasyonlar/${p.appliedReservationIds[0]}`}
                        className="text-turquoise-700 hover:underline"
                      >
                        Kayda git
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
