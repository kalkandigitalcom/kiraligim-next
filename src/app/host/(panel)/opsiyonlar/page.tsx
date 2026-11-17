import type { Metadata } from "next";

import { Alert } from "@/components/ui/alert";
import { durationInput, formatMinutes } from "@/lib/option-admin";
import {
  getOwnerOptionSettings,
  listOwnerClarifications,
  type OwnerClarification,
  type OwnerOptionSettings,
} from "@/server/options/owner";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { setOptionDefaultAction } from "./actions";
import { DefaultDurationForm } from "./default-duration-form";

export const metadata: Metadata = { title: "Opsiyonlar" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const NOTICES: Record<string, string> = {
  kaydedildi: "Varsayılan opsiyon süresi kaydedildi. Mevcut opsiyonların bitişi değişmez.",
  "degisiklik-yok": "Değişiklik yapılmadı.",
};

/** Açıklama bekleme nedenleri (işletme sahibine; mesaj içeriği gösterilmez). */
const REASONS: Record<string, string> = {
  question: "Mesaj soru",
  negated: "Olumsuz ifade",
  hedged: "Kesin olmayan ifade",
  intent_conflict: "Çelişen istek",
  intent_unclear: "Ne istendiği anlaşılmadı",
  date_missing: "Tarih yok",
  date_unclear: "Tarih belirsiz",
  date_past: "Giriş tarihi geçmiş ya da başlamış",
  multiple_ranges: "Birden çok tarih aralığı",
  villa_unclear: "Villa belirsiz",
  duration_unclear: "Süre belirsiz",
  duration_out_of_bounds: "Süre 1 saat – 14 gün dışında",
  duration_after_check_in: "Yazılan süre giriş tarihini aşıyor",
  check_in_too_close: "Girişe 60 dakikadan az kaldı",
  calendar_conflict: "Takvimde dolu kayıt var",
  option_overlap: "Aynı tarihlerde başka açık opsiyon var",
  option_expired: "Süre zaten dolmuş",
  property_inactive: "Villa pasif",
};

const dateTr = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Istanbul",
});
const dateTimeTr = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Istanbul",
});
const day = (iso: string) => dateTr.format(new Date(`${iso}T12:00:00Z`));

const CARD = "rounded-2xl border border-border bg-white p-6 shadow-sm";

type View =
  | { kind: "ok"; settings: OwnerOptionSettings; clarifications: OwnerClarification[] }
  | { kind: "staff" };

/**
 * İşletme paneli — opsiyonlar (Faz A): varsayılan opsiyon süresi (yalnız sahip değiştirir) ve
 * WhatsApp'tan gelip güvenle uygulanamayan, açıklama bekleyen opsiyon istekleri (salt okunur).
 * Personel rolü bu bölümü görmez.
 */
export default async function OptionsPage({ searchParams }: Props) {
  const sp = await searchParams;
  const view: View = await withPanelTenant(async (tx, ctx) =>
    ctx.role === "staff"
      ? { kind: "staff" as const }
      : {
          kind: "ok" as const,
          settings: await getOwnerOptionSettings(tx, ctx),
          clarifications: await listOwnerClarifications(tx, ctx),
        },
  );
  const notice = typeof sp.ayar === "string" ? NOTICES[sp.ayar] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-navy-900">Opsiyonlar</h1>
        <p className="mt-1 text-[15px] text-muted-foreground">
          WhatsApp grubunuzdan gelen opsiyon istekleri. Opsiyon takvimi kapatmaz; yalnız kesin
          rezervasyon müsaitliği etkiler.
        </p>
      </div>

      {view.kind === "staff" ? (
        <Alert tone="info">Opsiyon bölümünü işletme sahibi ve yöneticiler görür.</Alert>
      ) : (
        <>
          {notice ? <Alert tone="success">{notice}</Alert> : null}

          <section aria-labelledby="sure-baslik" className={CARD} data-testid="option-default">
            <h2 id="sure-baslik" className="text-base font-semibold text-navy-900">
              Varsayılan opsiyon süresi
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              WhatsApp mesajında süre yazılmamışsa kullanılır. Şu an{" "}
              <strong className="text-navy-900">
                {formatMinutes(view.settings.effectiveMinutes)}
              </strong>{" "}
              (
              {view.settings.effectiveSource === "workspace_default"
                ? "işletmenizin ayarı"
                : "sistem varsayılanı"}
              ). Süre giriş tarihini aşarsa opsiyon giriş saatinde biter; girişe 60 dakikadan az
              kalıyorsa istek açıklama bekler. Mesajda yazdığınız süre hiçbir zaman kısaltılmaz.
            </p>
            <div className="mt-4">
              {view.settings.canEdit ? (
                <DefaultDurationForm
                  action={setOptionDefaultAction}
                  initial={durationInput(view.settings.workspaceMinutes)}
                  systemLabel={formatMinutes(view.settings.systemMinutes)}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Varsayılan süreyi işletme sahibi değiştirebilir.
                </p>
              )}
              {view.settings.choices.length > 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Kullanılabilecek süreler:{" "}
                  {view.settings.choices.map((m) => formatMinutes(m)).join(", ")}
                </p>
              ) : null}
            </div>
          </section>

          <section
            aria-labelledby="aciklama-baslik"
            className={CARD}
            data-testid="option-clarifications"
          >
            <h2 id="aciklama-baslik" className="text-base font-semibold text-navy-900">
              Açıklama bekleyenler
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Güvenle uygulanamadığı için opsiyon açılmayan WhatsApp istekleri. Doğru bilgiyle gruba
              yeni bir mesaj yazmanız yeterlidir.
            </p>
            {view.clarifications.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">Açıklama bekleyen istek yok.</p>
            ) : (
              <ul className="mt-4 flex flex-col divide-y divide-border rounded-xl border border-border">
                {view.clarifications.map((c) => (
                  <li key={c.id} className="flex flex-col gap-1 px-4 py-3 text-sm">
                    <span className="font-medium text-navy-900">
                      {c.propertyName}
                      {c.checkIn && c.checkOut
                        ? ` · ${day(c.checkIn)} – ${day(c.checkOut)}`
                        : " · tarih yok"}
                    </span>
                    <span className="text-muted-foreground">
                      {c.reasons.length
                        ? c.reasons.map((r) => REASONS[r] ?? "Diğer").join(" · ")
                        : "Belirsiz istek"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Mesaj: {dateTimeTr.format(c.sentAt ?? c.createdAt)}
                    </span>
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
