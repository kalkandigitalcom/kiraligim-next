"use client";

import { MapPin, Route } from "lucide-react";

import { Field, FIELD_CONTROL_CLASS, SelectField } from "@/components/ui/field";
import { PROPERTY_LIMITS as L, PROPERTY_TYPE_LABELS, PROPERTY_TYPES } from "@/lib/property-meta";
import { TR_PROVINCES_SORTED } from "@/lib/tr-provinces";
import { cn } from "@/lib/utils";
import {
  DISTANCE_KEYS,
  DISTANCE_LABELS,
  DISTANCE_UNIT_KEYS,
  type DistanceKey,
  type DistanceUnitKey,
  isDistanceUnit,
} from "@/lib/villa-extras";

import type { WizardValues } from "../../actions";
import { MapLocationField } from "./map-location-field";
import { StepCard } from "./step-card";
import { type WizardAction, WizardFooter, WizardForm, useWizardForm } from "./wizard-form";

export type BasicsValues = Pick<
  WizardValues,
  | "name"
  | "propertyType"
  | "tourismLicenseNo"
  | "province"
  | "district"
  | "neighborhood"
  | "mapMode"
  | "mapLocation"
  | "mapPinLat"
  | "mapPinLng"
  | "maxGuests"
  | "bedrooms"
  | "bathrooms"
  | DistanceKey
  | DistanceUnitKey
>;

type Props = {
  action: WizardAction;
  initial: BasicsValues;
  readOnly: boolean;
  prevHref: string | null;
  nextHref: string | null;
  cancel?: { href: string; label: string };
};

const typeOptions = PROPERTY_TYPES.map((t) => ({ value: t, label: PROPERTY_TYPE_LABELS[t] }));
const provinceOptions = TR_PROVINCES_SORTED.map((p) => ({ value: p, label: p }));

function NumberField(props: {
  id: "maxGuests" | "bedrooms" | "bathrooms";
  label: string;
  value: string;
  error: string | undefined;
  min: number;
  max: number;
}) {
  return (
    <Field
      id={props.id}
      name={props.id}
      type="number"
      inputMode="numeric"
      min={props.min}
      max={props.max}
      label={props.label}
      defaultValue={props.value}
      error={props.error}
      required
    />
  );
}

/**
 * Mesafe: sayı + birim (km / m), her alan için ayrı. Birim kontrolsüz <select>; React form
 * sıfırlaması <select>'i yeni varsayılana döndürmediği için değer değişince yeniden kurulur.
 */
function DistanceField({
  k,
  value,
  unit,
  error,
}: {
  k: DistanceKey;
  value: string;
  unit: string;
  error: string | undefined;
}) {
  const unitKey = DISTANCE_UNIT_KEYS[k];
  const u = isDistanceUnit(unit) ? unit : "km";
  const hintId = `${k}-hata`;
  return (
    <div className="flex flex-col gap-1.5" data-testid={`distance-${k}`}>
      <label htmlFor={k} className="text-sm font-medium text-navy-900">
        {DISTANCE_LABELS[k]}
      </label>
      <div className="flex gap-2">
        <input
          id={k}
          name={k}
          inputMode="decimal"
          maxLength={8}
          autoComplete="off"
          defaultValue={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? hintId : undefined}
          className={cn(FIELD_CONTROL_CLASS, "h-11 min-w-0 flex-1")}
        />
        <select
          key={`${unitKey}-${u}`}
          id={unitKey}
          name={unitKey}
          defaultValue={u}
          aria-label={`${DISTANCE_LABELS[k]} birimi`}
          className={cn(FIELD_CONTROL_CLASS, "h-11 w-20 shrink-0 appearance-auto pr-6")}
        >
          <option value="km">km</option>
          <option value="m">m</option>
        </select>
      </div>
      {error ? (
        <p id={hintId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** 1. adım: villa, konum ve harita (iki yöntem), kapasite, yakın yerlere mesafeler (km / m). */
export function BasicsStep({ action, initial, readOnly, prevHref, nextHref, cancel }: Props) {
  const { state, formAction, pending, v, fe } = useWizardForm(action, initial);

  return (
    <>
      <WizardForm
        id="wizard-form"
        step="temel"
        state={state}
        formAction={formAction}
        readOnly={readOnly}
      >
        <StepCard id="villa-baslik" title="Villanız">
          <Field
            id="name"
            name="name"
            label="Mülk adı"
            hint="Misafirlerin göreceği ad. Ör. Villa Defne"
            maxLength={L.nameMax}
            defaultValue={v.name}
            error={fe.name}
            required
          />
          <SelectField
            // React form sıfırlaması <select>'i yeni varsayılana döndürmüyor: değer değişince yeniden kur.
            key={`propertyType-${v.propertyType}`}
            id="propertyType"
            name="propertyType"
            label="Mülk türü"
            options={typeOptions}
            defaultValue={v.propertyType}
            error={fe.propertyType}
            required
          />
          <Field
            id="tourismLicenseNo"
            name="tourismLicenseNo"
            label="Turizm belge numarası (isteğe bağlı)"
            hint="T.C. Kültür ve Turizm Bakanlığı belgeniz varsa numarasını yazın."
            maxLength={L.licenseMax}
            autoComplete="off"
            defaultValue={v.tourismLicenseNo}
            error={fe.tourismLicenseNo}
          />
        </StepCard>

        <StepCard
          id="konum-baslik"
          title="Konum"
          description="Misafirler il, ilçe ve mahalleyi görür."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              key={`province-${v.province}`}
              id="province"
              name="province"
              label="İl"
              options={provinceOptions}
              placeholder="İl seçin"
              defaultValue={v.province}
              error={fe.province}
              required
            />
            <Field
              id="district"
              name="district"
              label="İlçe"
              maxLength={L.placeMax}
              defaultValue={v.district}
              error={fe.district}
              required
            />
          </div>
          <Field
            id="neighborhood"
            name="neighborhood"
            label="Mahalle / köy (isteğe bağlı)"
            maxLength={L.neighborhoodMax}
            defaultValue={v.neighborhood}
            error={fe.neighborhood}
          />
        </StepCard>

        <StepCard
          id="harita-baslik"
          title="Harita (isteğe bağlı)"
          icon={<MapPin className="size-4" />}
          description="Villanızın yeri misafirlerinize villa sayfasında harita olarak gösterilir. İki yöntemden birini seçin."
        >
          <MapLocationField v={v} fe={fe} state={state} readOnly={readOnly} />
        </StepCard>

        <StepCard id="kapasite-baslik" title="Kapasite ve odalar">
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField
              id="maxGuests"
              label="Kişi kapasitesi"
              value={v.maxGuests}
              error={fe.maxGuests}
              min={L.guestsMin}
              max={L.guestsMax}
            />
            <NumberField
              id="bedrooms"
              label="Yatak odası"
              value={v.bedrooms}
              error={fe.bedrooms}
              min={0}
              max={L.roomsMax}
            />
            <NumberField
              id="bathrooms"
              label="Banyo"
              value={v.bathrooms}
              error={fe.bathrooms}
              min={0}
              max={L.roomsMax}
            />
          </div>
        </StepCard>

        <StepCard
          id="mesafe-baslik"
          title="Yakın yerlere mesafeler (isteğe bağlı)"
          icon={<Route className="size-4" />}
          description="Her mesafe için birimi seçin (km veya m); bilmediklerinizi boş bırakın. Ör. Market 500 m, Plaj 2 km, Merkez 1,5 km."
        >
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            {DISTANCE_KEYS.map((k) => (
              <DistanceField
                key={k}
                k={k}
                value={v[k]}
                unit={v[DISTANCE_UNIT_KEYS[k]]}
                error={fe[k] ?? fe[DISTANCE_UNIT_KEYS[k]]}
              />
            ))}
          </div>
        </StepCard>
      </WizardForm>
      <WizardFooter
        formId="wizard-form"
        prevHref={prevHref}
        nextHref={nextHref}
        readOnly={readOnly}
        pending={pending}
        cancel={cancel}
      />
    </>
  );
}
