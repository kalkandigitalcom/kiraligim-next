"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, SelectField } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  endFromLastNight,
  formatNights,
  formatPeriod,
  overlappingPeriods,
  RATE_LIMITS as L,
  type RatePeriod,
} from "@/lib/rate-meta";
import {
  CURRENCIES,
  type Currency,
  formatMoney,
  isIsoDate,
  nightsBetween,
  parseAmount,
  toMinor,
} from "@/lib/reservation-meta";

import type { RateFormState } from "./actions";

export type RateFormValues = {
  startDate: string;
  /** Bitiş günü (DAHİL); saklanırken ertesi gün hariç bitiş sınırına çevrilir. */
  lastNight: string;
  nightlyAmount: string;
  weeklyAmount: string;
  currency: string;
  minNights: string;
};

type Props = {
  mode: "create" | "edit";
  action: (state: RateFormState, data: FormData) => Promise<RateFormState>;
  initial: RateFormValues;
  /** Mülkün diğer dönemleri: canlı çakışma uyarısı için (asıl denetim sunucu ve veritabanında). */
  periods: Pick<RatePeriod, "id" | "startDate" | "endDate">[];
  /** Düzenlenen dönem (çakışma denetiminde kendisi hariç). */
  editingId?: string;
  /** Başlangıç için izin verilen aralık (bugün − 1 yıl … bugün + 3 yıl). */
  dateWindow: { min: string; max: string };
  cancelHref?: string;
  /** Mülkün diğer dönemlerinin para birimi: varsa para birimi bununla sabittir (3.2). */
  lockedCurrency?: Currency | null;
};

const currencyOptions = CURRENCIES.map((c) => ({ value: c, label: c }));

const amountPreview = (raw: string, currency: string) => {
  const n = parseAmount(raw);
  if (n === undefined || Number.isNaN(n) || n <= 0) return null;
  return formatMoney(toMinor(n), currency as Currency);
};

/**
 * Fiyat dönemi formu (oluşturma ve düzenleme). Başlangıç ve bitiş günleri DAHİL girilir; kayıtta
 * bitiş ertesi güne çevrilir ([başlangıç, bitiş + 1)). Canlı bilgiler (kapsanan günler,
 * çakışma, tutar önizlemesi) yalnız yardımcıdır; doğrulama sunucuda ve veritabanında.
 */
export function RateForm({
  mode,
  action,
  initial,
  periods,
  editingId,
  dateWindow,
  cancelHref,
  lockedCurrency = null,
}: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const hydrated = useHydrated();
  const v = state.values ?? initial;
  const fe = state.fieldErrors ?? {};
  // Hata sonrası formu sunucunun döndürdüğü değerlerle yeniden kurar (key).
  return (
    <form
      key={JSON.stringify(v)}
      action={formAction}
      noValidate
      className="flex flex-col gap-5"
      aria-label={mode === "edit" ? "Fiyat dönemini düzenle" : "Yeni fiyat dönemi"}
    >
      {state.error && Object.keys(fe).length === 0 ? (
        <Alert tone="error">{state.error}</Alert>
      ) : null}
      <Fields
        mode={mode}
        values={v}
        fe={fe}
        periods={periods}
        editingId={editingId}
        dateWindow={dateWindow}
        lockedCurrency={lockedCurrency}
      />
      <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:justify-end">
        {cancelHref ? (
          <Link href={cancelHref} className={buttonVariants({ variant: "secondary" })}>
            Vazgeç
          </Link>
        ) : null}
        <Button type="submit" className="w-full sm:w-auto" disabled={pending || !hydrated}>
          {pending ? "Kaydediliyor…" : mode === "edit" ? "Değişiklikleri kaydet" : "Dönemi ekle"}
        </Button>
      </div>
    </form>
  );
}

function Fields({
  mode,
  values,
  fe,
  periods,
  editingId,
  dateWindow,
  lockedCurrency,
}: {
  mode: "create" | "edit";
  values: RateFormValues;
  fe: Partial<Record<keyof RateFormValues, string>>;
  periods: Props["periods"];
  editingId?: string;
  dateWindow: Props["dateWindow"];
  lockedCurrency: Currency | null;
}) {
  const [start, setStart] = useState(values.startDate);
  const [last, setLast] = useState(values.lastNight);
  const [nightly, setNightly] = useState(values.nightlyAmount);
  const [weekly, setWeekly] = useState(values.weeklyAmount);
  const [currency, setCurrency] = useState(lockedCurrency ?? (values.currency || "TRY"));

  const valid = isIsoDate(start) && isIsoDate(last);
  // Başlangıç ve bitiş günleri DAHİL (1–30 Nisan: Nisan'ın tüm günleri); veritabanı aralığı
  // [start, last + 1). Fiyat takvim günlerine tanımlanır: gece sayısı gösterilmez.
  const nights = valid ? nightsBetween(start, last) + 1 : null;
  const end = valid ? endFromLastNight(last) : "";
  const conflicts =
    valid && nights !== null && nights > 0
      ? overlappingPeriods(
          start,
          end,
          periods.filter((p) => p.id !== editingId),
        )
      : [];
  const nightlyPreview = amountPreview(nightly, currency);
  const weeklyPreview = amountPreview(weekly, currency);
  const nightlyN = parseAmount(nightly);
  const weeklyN = parseAmount(weekly);
  const weeklyHigh =
    nightlyN !== undefined &&
    weeklyN !== undefined &&
    !Number.isNaN(nightlyN) &&
    !Number.isNaN(weeklyN) &&
    nightlyN > 0 &&
    toMinor(weeklyN) > L.weekNights * toMinor(nightlyN);

  return (
    <>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          id="startDate"
          name="startDate"
          type="date"
          label="Başlangıç"
          min={mode === "create" ? dateWindow.min : undefined}
          max={dateWindow.max}
          value={start}
          onChange={(e) => setStart(e.target.value)}
          error={fe.startDate}
          required
        />
        <Field
          id="lastNight"
          name="lastNight"
          type="date"
          label="Bitiş"
          min={isIsoDate(start) ? start : undefined}
          value={last}
          onChange={(e) => setLast(e.target.value)}
          error={fe.lastNight}
          hint="Başlangıç ve bitiş günleri dahildir; sonraki dönem ertesi gün başlayabilir."
          required
        />
      </div>
      <div
        className="-mt-2 flex flex-col gap-1 text-sm"
        aria-live="polite"
        data-testid="period-info"
      >
        {nights !== null && nights > 0 ? (
          nights > L.maxNights ? (
            <p className="text-destructive">
              Bir fiyat dönemi en fazla {L.maxNights} gün olabilir.
            </p>
          ) : (
            <p className="text-navy-900">Kapsanan günler: {formatNights(start, end)}</p>
          )
        ) : null}
        {conflicts.length ? (
          <p className="text-destructive" data-testid="period-conflict">
            Mevcut dönemle çakışıyor: {conflicts.map((c) => formatPeriod(c)).join("; ")}.
          </p>
        ) : null}
      </div>

      <div className="grid gap-5 sm:grid-cols-[1fr_1fr_8rem]">
        <Field
          id="nightlyAmount"
          name="nightlyAmount"
          inputMode="decimal"
          autoComplete="off"
          label="Gecelik fiyat"
          placeholder="5.000"
          value={nightly}
          onChange={(e) => setNightly(e.target.value)}
          error={fe.nightlyAmount}
          hint={nightlyPreview ? `${nightlyPreview} / gece` : "İsteğe bağlı"}
        />
        <Field
          id="weeklyAmount"
          name="weeklyAmount"
          inputMode="decimal"
          autoComplete="off"
          label="Haftalık fiyat (7 gece)"
          placeholder="35.000"
          value={weekly}
          onChange={(e) => setWeekly(e.target.value)}
          error={fe.weeklyAmount}
          hint={weeklyPreview ? `${weeklyPreview} / 7 gece` : "İsteğe bağlı"}
        />
        {lockedCurrency ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-navy-900">Para birimi</span>
            <input type="hidden" name="currency" value={lockedCurrency} />
            <p
              className="flex h-11 items-center rounded-lg border border-input bg-mist px-3 text-[15px] text-navy-900"
              data-testid="currency-locked"
            >
              {lockedCurrency}
            </p>
            {fe.currency ? <p className="text-sm text-destructive">{fe.currency}</p> : null}
          </div>
        ) : (
          <SelectField
            id="currency"
            name="currency"
            label="Para birimi"
            options={currencyOptions}
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            error={fe.currency}
          />
        )}
      </div>
      {lockedCurrency ? (
        <p className="-mt-2 text-sm text-muted-foreground">
          Bu mülkün tüm fiyat dönemleri {lockedCurrency} para biriminde tanımlanır.
        </p>
      ) : null}
      {weeklyHigh ? (
        <p
          data-testid="weekly-high-warning"
          className="-mt-2 rounded-lg border border-amber-500/50 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Haftalık fiyat, 7 gecelik gecelik toplamdan (
          {formatMoney(L.weekNights * toMinor(nightlyN!), currency as Currency)}) yüksek. 7 gece ve
          üzeri konaklamalarda tanımladığınız haftalık fiyat kullanılır; otomatik düzeltme yapılmaz.
        </p>
      ) : null}
      <p className="-mt-2 text-sm text-muted-foreground">
        Gecelik ve haftalık fiyattan en az birini girin. Haftalık fiyat, bu dönemde geçerli 7
        gecelik toplam fiyattır.
      </p>

      <div className="sm:w-56">
        <Field
          id="minNights"
          name="minNights"
          type="number"
          inputMode="numeric"
          min={L.minNightsMin}
          max={L.minNightsMax}
          label="Minimum konaklama (gece)"
          placeholder="İsteğe bağlı"
          defaultValue={values.minNights}
          error={fe.minNights}
        />
      </div>
    </>
  );
}
