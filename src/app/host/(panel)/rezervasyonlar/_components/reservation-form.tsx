"use client";

import { useActionState, useEffect, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, SelectField, TextareaField } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  balanceOf,
  CURRENCIES,
  type Currency,
  formatMoney,
  isIsoDate,
  nightsBetween,
  parseAmount,
  RESERVATION_LIMITS as L,
  MANUAL_RESERVATION_SOURCES,
  RESERVATION_SOURCE_LABELS,
  RESERVATION_SOURCES,
  type ReservationSource,
  toMinor,
} from "@/lib/reservation-meta";
import { cn } from "@/lib/utils";

import type { PropertyOption, ReservationFormValues } from "./form-values";
import { PriceQuote } from "./price-quote";
import {
  type AvailabilityResult,
  checkAvailabilityAction,
  type ReservationFormState,
} from "../actions";

type Props = {
  mode: "create" | "edit";
  action: (state: ReservationFormState, data: FormData) => Promise<ReservationFormState>;
  initial: ReservationFormValues;
  /** Oluşturmada yalnız aktif mülkler; düzenlemede kaydın mülkü (değiştirilemez). */
  properties: PropertyOption[];
  /** Giriş tarihi için izin verilen aralık (bugün − 1 yıl … bugün + 3 yıl, Europe/Istanbul). */
  dateWindow: { min: string; max: string };
  /** Düzenlenen kaydın kimliği: müsaitlik denetiminde kendisi hariç tutulur. */
  excludeId?: string;
};

const sourceOption = (s: ReservationSource) => ({ value: s, label: RESERVATION_SOURCE_LABELS[s] });
// "Web sitesi talebi" yalnız villa sayfasındaki formdan gelir: elle eklemede seçenek değildir;
// web talebi düzenlenirken kaynağı korunabilsin diye listede kalır.
const manualSourceOptions = MANUAL_RESERVATION_SOURCES.map(sourceOption);
const allSourceOptions = RESERVATION_SOURCES.map(sourceOption);
const currencyOptions = CURRENCIES.map((c) => ({ value: c, label: c }));

/** İki seçenekli düğme grubu (yerel radyo düğmeleri; klavyeyle seçilir). */
function Segmented({
  name,
  legend,
  value,
  options,
  onChange,
}: {
  name: string;
  legend: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (v: string) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium text-navy-900">{legend}</legend>
      <div className="inline-flex w-fit rounded-lg border border-input bg-white p-0.5">
        {options.map(([v, label]) => (
          <label
            key={v}
            className={cn(
              "flex h-9 min-w-24 cursor-pointer items-center justify-center rounded-md px-3 text-sm font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-turquoise-500/50",
              value === v ? "bg-navy-900 text-white" : "text-navy-900 hover:bg-mist",
            )}
          >
            <input
              type="radio"
              name={name}
              value={v}
              checked={value === v}
              onChange={() => onChange(v)}
              className="sr-only"
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-5 border-t border-border pt-6 first-of-type:border-t-0 first-of-type:pt-0">
      <legend className="float-left mb-1 w-full text-base font-semibold text-navy-900">
        {title}
      </legend>
      <div className="clear-left flex flex-col gap-5">{children}</div>
    </fieldset>
  );
}

/** Seçilen tarihler için müsaitlik ön denetimi (yalnız bilgi; asıl engel veritabanıdır). */
function useAvailability(
  propertyId: string,
  checkIn: string,
  checkOut: string,
  excludeId: string | undefined,
) {
  const [result, setResult] = useState<{ key: string; value: AvailabilityResult } | null>(null);
  const key = `${propertyId}|${checkIn}|${checkOut}`;
  const ready =
    propertyId !== "" && isIsoDate(checkIn) && isIsoDate(checkOut) && checkOut > checkIn;
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      checkAvailabilityAction(propertyId, checkIn, checkOut, excludeId)
        .then((value) => {
          if (!cancelled) setResult({ key, value });
        })
        .catch(() => undefined);
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [ready, key, propertyId, checkIn, checkOut, excludeId]);
  return ready && result?.key === key ? result.value : null;
}

function FormBody({
  mode,
  initial,
  properties,
  dateWindow,
  excludeId,
  fe,
  pending,
}: Omit<Props, "action"> & {
  fe: Partial<Record<keyof ReservationFormValues, string>>;
  pending: boolean;
}) {
  const hydrated = useHydrated();
  const [kind, setKind] = useState(initial.kind === "block" ? "block" : "reservation");
  const [status, setStatus] = useState(initial.status === "pending" ? "pending" : "confirmed");
  const [propertyId, setPropertyId] = useState(
    initial.propertyId || (properties.length === 1 ? properties[0]!.id : ""),
  );
  const [checkIn, setCheckIn] = useState(initial.checkIn);
  const [checkOut, setCheckOut] = useState(initial.checkOut);
  const [total, setTotal] = useState(initial.totalAmount);
  const [deposit, setDeposit] = useState(initial.depositAmount);
  const [currency, setCurrency] = useState(initial.currency || "TRY");
  const isBlock = kind === "block";
  const property = properties.find((p) => p.id === propertyId);

  const nights =
    isIsoDate(checkIn) && isIsoDate(checkOut) ? nightsBetween(checkIn, checkOut) : null;
  const availability = useAvailability(propertyId, checkIn, checkOut, excludeId);

  const totalN = parseAmount(total);
  const depositN = parseAmount(deposit);
  const balance =
    totalN !== undefined && !Number.isNaN(totalN)
      ? balanceOf(
          toMinor(totalN),
          depositN !== undefined && !Number.isNaN(depositN) ? toMinor(depositN) : null,
        )
      : null;

  return (
    <>
      <input type="hidden" name="kind" value={kind} />
      {mode === "edit" ? <input type="hidden" name="propertyId" value={propertyId} /> : null}

      <Section title={isBlock ? "Blok" : "Konaklama"}>
        {mode === "create" ? (
          <Segmented
            name="kindChoice"
            legend="Kayıt türü"
            value={kind}
            options={[
              ["reservation", "Rezervasyon"],
              ["block", "Blok (kapalı tarih)"],
            ]}
            onChange={setKind}
          />
        ) : null}
        {mode === "create" ? (
          properties.length === 0 ? (
            <Alert tone="info">
              Rezervasyon eklenebilecek aktif mülk yok. Pasif mülklere yeni kayıt eklenemez.
            </Alert>
          ) : (
            <SelectField
              id="propertyId"
              name="propertyId"
              label="Mülk"
              options={properties.map((p) => ({ value: p.id, label: p.name }))}
              placeholder={properties.length > 1 ? "Mülk seçin" : undefined}
              value={propertyId}
              onChange={(e) => setPropertyId(e.target.value)}
              error={fe.propertyId}
              required
            />
          )
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-navy-900">Mülk</span>
            <p className="text-[15px] text-navy-900">{property?.name ?? "—"}</p>
            <p className="text-sm text-muted-foreground">
              Mülk değiştirilemez; gerekirse kaydı iptal edip yeni kayıt oluşturun.
            </p>
          </div>
        )}
        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            id="checkIn"
            name="checkIn"
            type="date"
            label={isBlock ? "Başlangıç" : "Giriş tarihi"}
            min={mode === "create" ? dateWindow.min : undefined}
            max={dateWindow.max}
            value={checkIn}
            onChange={(e) => setCheckIn(e.target.value)}
            error={fe.checkIn}
            required
          />
          <Field
            id="checkOut"
            name="checkOut"
            type="date"
            label={isBlock ? "Bitiş (bu gün açık)" : "Çıkış tarihi"}
            min={isIsoDate(checkIn) ? checkIn : undefined}
            value={checkOut}
            onChange={(e) => setCheckOut(e.target.value)}
            error={fe.checkOut}
            required
          />
        </div>
        <div className="flex flex-col gap-1 text-sm" aria-live="polite" data-testid="stay-info">
          {nights !== null && nights > 0 ? (
            <p className="text-navy-900">
              {nights} gece{isBlock ? " kapatılacak" : ""}
            </p>
          ) : null}
          {availability ? (
            availability.available ? (
              <p className="text-turquoise-700">Bu tarihler müsait.</p>
            ) : (
              <p className="text-destructive">{availability.message}</p>
            )
          ) : null}
        </div>
        {mode === "create" && !isBlock ? (
          <Segmented
            name="status"
            legend="Durum"
            value={status}
            options={[
              ["confirmed", "Onaylı"],
              ["pending", "Beklemede"],
            ]}
            onChange={setStatus}
          />
        ) : null}
      </Section>

      {isBlock ? null : (
        <Section title="Misafir">
          <Field
            id="guestName"
            name="guestName"
            label="Misafir adı soyadı"
            autoComplete="off"
            maxLength={L.guestNameMax}
            defaultValue={initial.guestName}
            error={fe.guestName}
            required
          />
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              id="guestPhone"
              name="guestPhone"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              label="Telefon (isteğe bağlı)"
              placeholder="+90 532 123 45 67"
              maxLength={L.phoneMax}
              defaultValue={initial.guestPhone}
              error={fe.guestPhone}
            />
            <Field
              id="guestEmail"
              name="guestEmail"
              type="email"
              inputMode="email"
              autoComplete="off"
              label="E-posta (isteğe bağlı)"
              maxLength={L.emailMax}
              defaultValue={initial.guestEmail}
              error={fe.guestEmail}
            />
          </div>
          <div className="grid gap-5 sm:grid-cols-3">
            <Field
              id="adults"
              name="adults"
              type="number"
              inputMode="numeric"
              min={1}
              max={L.guestsMax}
              label="Yetişkin"
              defaultValue={initial.adults}
              error={fe.adults}
              required
            />
            <Field
              id="children"
              name="children"
              type="number"
              inputMode="numeric"
              min={0}
              max={L.guestsMax}
              label="Çocuk"
              defaultValue={initial.children}
              error={fe.children}
            />
            <SelectField
              id="source"
              name="source"
              label="Kaynak"
              options={initial.source === "web" ? allSourceOptions : manualSourceOptions}
              defaultValue={initial.source || "direct"}
              error={fe.source}
            />
          </div>
          {property ? (
            <p className="-mt-2 text-sm text-muted-foreground">
              Mülk kapasitesi: {property.maxGuests} kişi.
            </p>
          ) : null}
        </Section>
      )}

      {isBlock ? null : (
        <Section title="Ödeme">
          <PriceQuote
            propertyId={propertyId}
            propertyName={property?.name ?? ""}
            checkIn={checkIn}
            checkOut={checkOut}
            currentTotal={total}
            currentCurrency={currency}
            onUse={(amount, c) => {
              setTotal(amount);
              setCurrency(c);
            }}
          />
          <div className="grid gap-5 sm:grid-cols-[1fr_1fr_8rem]">
            <Field
              id="totalAmount"
              name="totalAmount"
              inputMode="decimal"
              autoComplete="off"
              label="Toplam tutar (isteğe bağlı)"
              placeholder="12.500,00"
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              error={fe.totalAmount}
            />
            <Field
              id="depositAmount"
              name="depositAmount"
              inputMode="decimal"
              autoComplete="off"
              label="Ön ödeme (isteğe bağlı)"
              placeholder="2.500,00"
              value={deposit}
              onChange={(e) => setDeposit(e.target.value)}
              error={fe.depositAmount}
            />
            <SelectField
              id="currency"
              name="currency"
              label="Para birimi"
              options={currencyOptions}
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              error={fe.currency}
            />
          </div>
          <p className="text-sm text-navy-900" aria-live="polite" data-testid="balance">
            Kalan tutar:{" "}
            <span className="font-semibold tabular-nums">
              {balance === null ? "—" : formatMoney(balance, currency as Currency)}
            </span>
          </p>
        </Section>
      )}

      <Section title={isBlock ? "Açıklama" : "Not"}>
        <TextareaField
          id="note"
          name="note"
          label={isBlock ? "Açıklama (isteğe bağlı, ör. Bakım)" : "İç not (isteğe bağlı)"}
          maxLength={L.noteMax}
          className="min-h-20"
          defaultValue={initial.note}
          error={fe.note}
        />
      </Section>

      <div className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:justify-end">
        <Button
          type="submit"
          className="w-full sm:w-auto"
          disabled={pending || !hydrated || (mode === "create" && properties.length === 0)}
        >
          {pending
            ? "Kaydediliyor…"
            : mode === "edit"
              ? "Değişiklikleri kaydet"
              : isBlock
                ? "Bloğu kaydet"
                : "Rezervasyonu kaydet"}
        </Button>
      </div>
    </>
  );
}

export function ReservationForm(props: Props) {
  const [state, formAction, pending] = useActionState(props.action, {});
  const values = (state.values as ReservationFormValues | undefined) ?? props.initial;
  const fe = state.fieldErrors ?? {};
  return (
    <form action={formAction} noValidate className="flex flex-col gap-8">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <FormBody
        // Sunucudan dönen değerlerle (hata sonrası) alanlar yeniden kurulur.
        key={state.values ? JSON.stringify(state.values) : "initial"}
        {...props}
        initial={values}
        fe={fe}
        pending={pending}
      />
    </form>
  );
}
