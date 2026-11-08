"use client";

import { CalendarDays, CircleCheck, Minus, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { requestReservationAction } from "@/app/site/(villa)/villa/[slug]/actions";
import { selectStayDay } from "@/lib/public-stay";
import { startingNightly } from "@/lib/public-villa-view";
import { formatDay, formatMoney, formatStay, type Currency } from "@/lib/reservation-meta";
import {
  REQUEST_ERROR_MESSAGES,
  REQUEST_LIMITS,
  type RequestFieldErrors,
  type RequestResult,
} from "@/lib/reservation-request";
import { cn } from "@/lib/utils";

import { AvailabilityCalendar } from "./availability-calendar";
import { useStay } from "./stay-context";
import { Notice, QuoteBody, WaLink, WhatsAppIcon } from "./stay-summary";

const INPUT =
  "h-11 w-full rounded-lg border border-border bg-white px-3 text-[15px] text-navy-900 placeholder:text-navy-900/40 focus-visible:border-turquoise-500 focus-visible:ring-3 focus-visible:ring-turquoise-500/25 focus-visible:outline-none aria-invalid:border-destructive";

type Form = { name: string; phone: string; email: string; note: string; consent: boolean };
const EMPTY_FORM: Form = { name: "", phone: "", email: "", note: "", consent: false };

/**
 * Rezervasyon kartı (F3): sayfadaki TEK rezervasyon formu. Masaüstünde sağ sütunda (yapışkan),
 * mobilde içerikte; ikisi aynı öğedir (sayfa ızgarası yerleşimi değiştirir). Tarih ve kişi seçimi
 * sayfanın ortak durumundadır (StayProvider): burada seçilen tarih sayfadaki takvimde, takvimde
 * seçilen burada görünür. Fiyat mevcut quoteStay ile gösterilir; gönderimde sunucu müsaitliği ve
 * fiyatı YENİDEN hesaplar (istemci tutar göndermez).
 *
 * Form alanları kontrollüdür ve sunucu eylemi form eylemi olarak değil, doğrudan çağrılır: hata
 * durumunda (ör. tarihler bu arada doldu) girilen bilgiler kaybolmaz. Başarıdan sonra form
 * kaldırılır; aynı talep ikinci kez gönderilemez.
 */
export function BookingCard({ className }: { className?: string }) {
  const stay = useStay();
  const {
    evaluation: e,
    selection,
    busy,
    window: w,
    rates,
    currency,
    maxGuests,
    guests,
    setGuests,
    whatsappHref,
    villaName,
    slug,
    requestEnabled,
  } = stay;
  const router = useRouter();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [result, setResult] = useState<RequestResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [openedAt] = useState(() => Date.now());
  const [honeypot, setHoneypot] = useState("");

  const from = currency ? startingNightly(rates, currency) : null;
  const datesReady = e.state === "quote" || e.state === "unpriced";
  const success = result?.ok ? result : null;
  const failure = result && !result.ok ? result : null;
  const fe: RequestFieldErrors = failure?.fieldErrors ?? {};

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    // Düzeltilen alanın eski hatası kalkar; alan hatası kalmayınca genel uyarı da kalkar.
    setResult((r) => {
      if (!r || r.ok || !r.fieldErrors?.[k]) return r;
      const rest = { ...r.fieldErrors };
      delete rest[k];
      return Object.keys(rest).length > 0 || r.code !== "invalid"
        ? { ...r, fieldErrors: rest }
        : null;
    });
  };

  const onDayPicked = (date: string) => {
    // Çıkış tamamlandıysa seçici kapanır (karar tıklamadan önceki seçime göre verilir).
    const next = selectStayDay(selection, date, busy, w);
    if (next.checkIn && next.checkOut) setPickerOpen(false);
  };

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!requestEnabled || !slug || pending || success || !datesReady) return;
    if (!selection.checkIn || !selection.checkOut) return;
    const payload = {
      slug,
      checkIn: selection.checkIn,
      checkOut: selection.checkOut,
      guests,
      name: form.name,
      phone: form.phone,
      email: form.email,
      note: form.note,
      consent: form.consent,
      website: honeypot,
      openedAt,
    };
    startTransition(async () => {
      let r: RequestResult;
      try {
        r = await requestReservationAction(payload);
      } catch {
        r = { ok: false, code: "server_error", message: REQUEST_ERROR_MESSAGES.server_error };
      }
      setResult(r);
      // Tarihler bu arada dolduysa takvim (dolu aralıklar) sunucudan yenilenir; seçim ve form durur.
      if (!r.ok && (r.code === "dates_unavailable" || r.code === "min_nights")) router.refresh();
    });
  };

  return (
    <div
      id="rezervasyon"
      className={cn(
        "scroll-mt-6 rounded-3xl border border-border bg-white p-5 shadow-xl shadow-navy-900/5 sm:p-6",
        className,
      )}
      data-testid="booking-card"
    >
      {/* Başlık: seçili konaklamanın toplamı ya da gecelik başlangıç fiyatı */}
      {e.state === "quote" ? (
        <div className="mb-4">
          <p className="text-sm text-navy-900/60">
            {formatStay(e.checkIn, e.checkOut)} · {e.nights} gece
          </p>
          <p className="text-2xl font-extrabold tracking-tight" data-testid="booking-headline">
            {formatMoney(e.quote.totalMinor!, e.quote.currency!)}
          </p>
        </div>
      ) : from !== null && currency ? (
        <div className="mb-4">
          <p className="text-sm text-navy-900/60">Gecelik başlangıç fiyatı</p>
          <p className="text-2xl font-extrabold tracking-tight" data-testid="booking-headline">
            {formatMoney(from, currency)}
          </p>
        </div>
      ) : (
        <p className="mb-4 text-[15px] text-navy-900/75">
          Fiyat ve müsaitlik için ev sahibine yazın.
        </p>
      )}

      {success ? (
        <SuccessPanel r={success} villaName={villaName} />
      ) : (
        <form
          onSubmit={submit}
          noValidate
          className="flex flex-col gap-4"
          aria-label="Rezervasyon talebi"
        >
          {/* Tarihler */}
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-border">
              <DateButton
                label="Giriş"
                value={selection.checkIn}
                open={pickerOpen}
                onClick={() => setPickerOpen((o) => !o)}
                testId="booking-checkin"
              />
              <DateButton
                label="Çıkış"
                value={selection.checkOut}
                open={pickerOpen}
                onClick={() => setPickerOpen((o) => !o)}
                testId="booking-checkout"
                className="border-l border-border"
              />
            </div>
            {pickerOpen ? (
              <div id="booking-date-picker" className="rounded-2xl bg-white">
                <AvailabilityCalendar compact onDayPicked={onDayPicked} />
              </div>
            ) : null}
          </div>

          {/* Kişi sayısı */}
          <GuestStepper value={guests} max={maxGuests} onChange={setGuests} error={fe.guests} />

          {/* Fiyat / uyarı */}
          {e.state === "empty" ? null : e.state === "checkout" ? (
            <p className="text-sm text-navy-900/70">
              Giriş: <strong>{formatDay(e.checkIn)}</strong>. Çıkış tarihini seçin.
            </p>
          ) : (
            <div aria-live="polite">
              <QuoteBody e={e} rates={rates} compact />
            </div>
          )}

          {/* İletişim formu */}
          <fieldset className="flex flex-col gap-3" disabled={pending}>
            <legend className="mb-1 text-[15px] font-semibold">İletişim bilgileriniz</legend>
            <TextField
              id="req-name"
              label="Ad Soyad"
              autoComplete="name"
              value={form.name}
              onChange={(v) => set("name", v)}
              error={fe.name}
              maxLength={REQUEST_LIMITS.nameMax}
              required
            />
            <TextField
              id="req-phone"
              label="Telefon"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="0532 123 45 67"
              value={form.phone}
              onChange={(v) => set("phone", v)}
              error={fe.phone}
              maxLength={24}
              required
            />
            <TextField
              id="req-email"
              label="E-posta (isteğe bağlı)"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={form.email}
              onChange={(v) => set("email", v)}
              error={fe.email}
              maxLength={REQUEST_LIMITS.emailMax}
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="req-mesaj" className="text-sm font-medium">
                Not (isteğe bağlı)
              </label>
              <textarea
                id="req-mesaj"
                value={form.note}
                onChange={(ev) => set("note", ev.target.value)}
                maxLength={REQUEST_LIMITS.noteMax}
                rows={3}
                placeholder="Ör. Geliş saatimiz, çocuk yaşları, özel istekler"
                aria-invalid={fe.note ? true : undefined}
                aria-describedby={fe.note ? "req-mesaj-hata" : undefined}
                className={cn(INPUT, "h-auto min-h-20 py-2.5 leading-relaxed")}
              />
              {fe.note ? (
                <p id="req-mesaj-hata" className="text-sm text-destructive">
                  {fe.note}
                </p>
              ) : null}
            </div>
            {/* Tuzak alan: görünmez, ekran okuyucudan gizli; bot doldurursa talep reddedilir. */}
            <div aria-hidden="true" className="sr-only">
              <label htmlFor="req-website">Bu alanı boş bırakın</label>
              <input
                id="req-website"
                tabIndex={-1}
                autoComplete="off"
                value={honeypot}
                onChange={(ev) => setHoneypot(ev.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-sm text-navy-900/70" id="req-kvkk">
                Ad, telefon ve (varsa) e-posta bilgileriniz yalnız bu talebin {villaName} ev
                sahibine iletilmesi ve talebinizle ilgili sizinle iletişim kurulması amacıyla
                işlenir ve ev sahibiyle paylaşılır.
              </p>
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={form.consent}
                  onChange={(ev) => set("consent", ev.target.checked)}
                  aria-invalid={fe.consent ? true : undefined}
                  aria-describedby="req-kvkk"
                  className="mt-0.5 size-4 shrink-0 accent-navy-900"
                  data-testid="req-consent"
                />
                <span>
                  Yukarıdaki bilgilendirmeyi okudum; bilgilerimin bu amaçla işlenmesini ve ev
                  sahibiyle paylaşılmasını kabul ediyorum.
                </span>
              </label>
              {fe.consent ? <p className="text-sm text-destructive">{fe.consent}</p> : null}
            </div>
          </fieldset>

          {failure ? (
            <Notice tone="warn" testId="booking-error">
              {failure.message}
            </Notice>
          ) : null}

          <div className="flex flex-col gap-2">
            <button
              type="submit"
              disabled={!requestEnabled || !datesReady || pending}
              aria-describedby={!datesReady ? "booking-need-dates" : undefined}
              className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-navy-900 px-4 text-[15px] font-semibold text-white transition-colors hover:bg-navy-800 focus-visible:ring-3 focus-visible:ring-turquoise-500/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="booking-submit"
            >
              {pending ? "Gönderiliyor…" : "Rezervasyon Talebi Gönder"}
            </button>
            {!requestEnabled ? (
              <p className="text-sm text-amber-900" data-testid="booking-preview-note">
                Önizleme: talep formu yayındaki sayfada çalışır.
              </p>
            ) : !datesReady ? (
              <p id="booking-need-dates" className="text-sm text-navy-900/60">
                Talep göndermek için müsait giriş ve çıkış tarihlerini seçin.
              </p>
            ) : null}
            <WaLink
              href={whatsappHref}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-[#1f7a4d] px-4 text-[15px] font-semibold text-[#1f7a4d] transition-colors hover:bg-[#1f7a4d]/5 focus-visible:ring-3 focus-visible:ring-turquoise-500/50 focus-visible:outline-none"
              testId="villa-whatsapp"
            >
              <WhatsAppIcon />
              WhatsApp ile İletişime Geç
            </WaLink>
            {whatsappHref === null ? (
              <p className="text-sm text-amber-900" data-testid="whatsapp-missing">
                İşletmenin WhatsApp numarası tanımlı değil; müşteri iletişim düğmesini kullanamaz.
              </p>
            ) : null}
          </div>
          <p className="text-sm text-navy-900/60">
            En fazla {maxGuests} kişi. Talebiniz ev sahibine iletilir; rezervasyon ev sahibi
            onayladığında kesinleşir. WhatsApp ile yazdığınızda talep kaydı oluşturulmaz.
          </p>
        </form>
      )}
    </div>
  );
}

function DateButton({
  label,
  value,
  open,
  onClick,
  testId,
  className,
}: {
  label: string;
  value: string | null;
  open: boolean;
  onClick: () => void;
  testId: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-controls="booking-date-picker"
      className={cn(
        "flex min-h-14 flex-col items-start justify-center px-3.5 py-2 text-left hover:bg-mist focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none focus-visible:ring-inset",
        className,
      )}
      data-testid={testId}
      data-value={value ?? ""}
    >
      <span className="text-xs font-semibold tracking-wide text-navy-900/60 uppercase">
        {label}
      </span>
      <span className="flex items-center gap-1.5 text-[15px] font-medium">
        <CalendarDays aria-hidden className="size-4 text-turquoise-700" />
        {value ? formatDay(value) : "Tarih seçin"}
      </span>
    </button>
  );
}

function GuestStepper({
  value,
  max,
  onChange,
  error,
}: {
  value: number;
  max: number;
  onChange: (n: number) => void;
  error: string | undefined;
}) {
  const btn =
    "inline-flex size-10 items-center justify-center rounded-full border border-border text-navy-900 hover:bg-mist focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-35";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3.5 py-2">
        <div>
          <p
            className="text-xs font-semibold tracking-wide text-navy-900/60 uppercase"
            id="guests-label"
          >
            Misafir
          </p>
          <p className="text-[15px] font-medium" aria-live="polite" data-testid="guests-value">
            {value} kişi
          </p>
        </div>
        <div className="flex items-center gap-2" role="group" aria-labelledby="guests-label">
          <button
            type="button"
            onClick={() => onChange(value - 1)}
            disabled={value <= 1}
            aria-label="Kişi sayısını azalt"
            className={btn}
            data-testid="guests-dec"
          >
            <Minus aria-hidden className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => onChange(value + 1)}
            disabled={value >= max}
            aria-label="Kişi sayısını artır"
            className={btn}
            data-testid="guests-inc"
          >
            <Plus aria-hidden className="size-4" />
          </button>
        </div>
      </div>
      <p className="text-xs text-navy-900/55">En fazla {max} kişi</p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  error,
  ...input
}: Omit<React.ComponentProps<"input">, "onChange" | "value"> & {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(ev) => onChange(ev.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-hata` : undefined}
        className={INPUT}
        {...input}
      />
      {error ? (
        <p id={`${id}-hata`} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SuccessPanel({
  r,
  villaName,
}: {
  r: Extract<RequestResult, { ok: true }>;
  villaName: string;
}) {
  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-2xl border border-turquoise-500/40 bg-turquoise-50 p-4"
      data-testid="booking-success"
    >
      <p className="flex items-center gap-2 text-base font-bold text-navy-900">
        <CircleCheck aria-hidden className="size-5 text-turquoise-700" />
        Talebiniz alındı
      </p>
      <dl className="flex flex-col gap-1 text-[15px]">
        <div className="flex justify-between gap-3">
          <dt className="text-navy-900/65">Talep no</dt>
          <dd className="font-semibold tabular-nums" data-testid="booking-reference">
            {r.reference}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-navy-900/65">Tarih</dt>
          <dd className="text-right font-medium">{formatStay(r.checkIn, r.checkOut)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-navy-900/65">Kişi</dt>
          <dd className="font-medium">{r.guests}</dd>
        </div>
        {r.totalMinor !== null && r.currency ? (
          <div className="flex justify-between gap-3">
            <dt className="text-navy-900/65">Hesaplanan tutar</dt>
            <dd className="font-medium">{formatMoney(r.totalMinor, r.currency as Currency)}</dd>
          </div>
        ) : null}
      </dl>
      <p className="text-sm text-navy-900/75">
        {villaName} ev sahibi talebinizi inceleyip sizinle iletişime geçecek. Rezervasyonunuz ev
        sahibi onayladığında kesinleşir; bu aşamada ödeme alınmaz.
      </p>
    </div>
  );
}
