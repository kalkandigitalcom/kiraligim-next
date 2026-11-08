"use client";

import { Lock } from "lucide-react";
import { useState } from "react";

import { Field, SelectField, TextareaField } from "@/components/ui/field";
import {
  mapLink,
  PROPERTY_LIMITS as L,
  PROPERTY_TYPE_LABELS,
  PROPERTY_TYPES,
} from "@/lib/property-meta";
import { PRIVATE_FIELDS } from "@/lib/property-wizard";
import { TR_PROVINCES_SORTED } from "@/lib/tr-provinces";

import type { WizardValues } from "../../actions";
import { StepCard } from "./step-card";
import { type WizardAction, WizardFooter, WizardForm, useWizardForm } from "./wizard-form";

export type BasicsValues = Pick<
  WizardValues,
  | "name"
  | "propertyType"
  | "province"
  | "district"
  | "neighborhood"
  | "maxGuests"
  | "bedrooms"
  | "bathrooms"
  | "bedsDouble"
  | "bedsSingle"
  | "bedsSofa"
  | "addressLine"
  | "postalCode"
  | "latitude"
  | "longitude"
  | "tourismLicenseNo"
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

function parseCoord(v: string, min: number, max: number): number | null {
  if (!v.trim()) return null;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function NumberField(props: {
  id: keyof BasicsValues;
  label: string;
  value: string;
  error: string | undefined;
  min: number;
  max: number;
  required?: boolean;
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
      required={props.required}
    />
  );
}

/** 1. adım: ad, tür, yer, kapasite, odalar ve yataklar; kapalı "Yalnız sizin için" bölümü. */
export function BasicsStep({ action, initial, readOnly, prevHref, nextHref, cancel }: Props) {
  const { state, formAction, pending, v, fe } = useWizardForm(action, initial);
  // Yalnız "Haritada aç" bağlantısını canlı göstermek için izlenir; değerler formdan gönderilir.
  const [lat, setLat] = useState(v.latitude);
  const [lng, setLng] = useState(v.longitude);
  const la = parseCoord(lat, -90, 90);
  const lo = parseCoord(lng, -180, 180);
  const privateError = PRIVATE_FIELDS.some((k) => fe[k]);
  const privateFilled = PRIVATE_FIELDS.filter((k) => v[k].trim() !== "").length;

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

        <StepCard id="kapasite-baslik" title="Kapasite, odalar ve yataklar">
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField
              id="maxGuests"
              label="Kişi kapasitesi"
              value={v.maxGuests}
              error={fe.maxGuests}
              min={L.guestsMin}
              max={L.guestsMax}
              required
            />
            <NumberField
              id="bedrooms"
              label="Yatak odası"
              value={v.bedrooms}
              error={fe.bedrooms}
              min={0}
              max={L.roomsMax}
              required
            />
            <NumberField
              id="bathrooms"
              label="Banyo"
              value={v.bathrooms}
              error={fe.bathrooms}
              min={0}
              max={L.roomsMax}
              required
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField
              id="bedsDouble"
              label="Çift kişilik yatak"
              value={v.bedsDouble}
              error={fe.bedsDouble}
              min={0}
              max={L.bedsMax}
            />
            <NumberField
              id="bedsSingle"
              label="Tek kişilik yatak"
              value={v.bedsSingle}
              error={fe.bedsSingle}
              min={0}
              max={L.bedsMax}
            />
            <NumberField
              id="bedsSofa"
              label="Çekyat / kanepe yatak"
              value={v.bedsSofa}
              error={fe.bedsSofa}
              min={0}
              max={L.bedsMax}
            />
          </div>
        </StepCard>

        <details
          // Bu bölümde hata varsa açık gelir.
          open={privateError || undefined}
          className="group rounded-2xl border border-border bg-white shadow-sm"
          data-testid="private-section"
        >
          <summary className="flex cursor-pointer list-none items-start gap-3 rounded-2xl p-5 select-none focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none sm:p-6 [&::-webkit-details-marker]:hidden">
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-mist text-navy-900"
            >
              <Lock className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold text-navy-900">Yalnız sizin için</span>
              <span className="mt-0.5 block text-sm text-muted-foreground">
                Açık adres, posta kodu, harita konumu ve belge numarası. Misafirlere gösterilmez.
                {privateFilled > 0 ? ` (${privateFilled}/${PRIVATE_FIELDS.length} dolu)` : ""}
              </span>
            </span>
            <span
              aria-hidden
              className="mt-1 text-sm font-medium text-turquoise-700 group-open:hidden"
            >
              Aç
            </span>
            <span
              aria-hidden
              className="mt-1 hidden text-sm font-medium text-turquoise-700 group-open:inline"
            >
              Kapat
            </span>
          </summary>
          <div className="flex flex-col gap-4 border-t border-border p-5 sm:p-6">
            <TextareaField
              id="addressLine"
              name="addressLine"
              label="Açık adres (isteğe bağlı)"
              maxLength={L.addressMax}
              className="min-h-20"
              defaultValue={v.addressLine}
              error={fe.addressLine}
            />
            <Field
              id="postalCode"
              name="postalCode"
              label="Posta kodu (isteğe bağlı)"
              inputMode="numeric"
              maxLength={5}
              className="sm:max-w-40"
              defaultValue={v.postalCode}
              error={fe.postalCode}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="latitude"
                name="latitude"
                label="Enlem (isteğe bağlı)"
                inputMode="decimal"
                placeholder="36.265100"
                defaultValue={v.latitude}
                onChange={(e) => setLat(e.target.value)}
                error={fe.latitude}
              />
              <Field
                id="longitude"
                name="longitude"
                label="Boylam (isteğe bağlı)"
                inputMode="decimal"
                placeholder="29.414300"
                defaultValue={v.longitude}
                onChange={(e) => setLng(e.target.value)}
                error={fe.longitude}
              />
            </div>
            <p className="-mt-1 text-sm text-muted-foreground">
              Telefonunuzdaki harita uygulamasında villanızın üzerine basılı tutun; görünen iki
              sayıyı (ör. 36.2651 ve 29.4143) buraya yazın.{" "}
              {la !== null && lo !== null ? (
                <a
                  href={mapLink(la, lo)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-turquoise-700 hover:underline"
                >
                  Haritada aç
                  <span className="sr-only"> (yeni sekmede açılır)</span>
                </a>
              ) : null}
            </p>
            <Field
              id="tourismLicenseNo"
              name="tourismLicenseNo"
              label="T.C. Kültür ve Turizm Bakanlığı Belge No (isteğe bağlı)"
              maxLength={L.licenseMax}
              autoComplete="off"
              defaultValue={v.tourismLicenseNo}
              error={fe.tourismLicenseNo}
            />
          </div>
        </details>
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
