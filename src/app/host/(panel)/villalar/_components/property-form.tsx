"use client";

import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, SelectField, TextareaField } from "@/components/ui/field";
import {
  mapLink,
  PROPERTY_LIMITS as L,
  PROPERTY_TYPE_LABELS,
  PROPERTY_TYPES,
} from "@/lib/property-meta";
import { TR_PROVINCES_SORTED } from "@/lib/tr-provinces";

import type { PropertyFormState } from "../actions";
import { PoolFields, type PoolFormValues } from "./pool-fields";
import { RichTextEditor } from "./rich-text-editor";
import { YoutubeField } from "./youtube-field";

export type PropertyFormValues = PoolFormValues & {
  name: string;
  propertyType: string;
  /** Temizlenmiş HTML (sunucudan). */
  description: string;
  tourismLicenseNo: string;
  youtubeUrls: string[];
  maxGuests: string;
  bedrooms: string;
  bathrooms: string;
  bedsDouble: string;
  bedsSingle: string;
  bedsSofa: string;
  province: string;
  district: string;
  neighborhood: string;
  addressLine: string;
  postalCode: string;
  latitude: string;
  longitude: string;
};

export const EMPTY_PROPERTY: PropertyFormValues = {
  name: "",
  propertyType: "villa",
  description: "",
  tourismLicenseNo: "",
  youtubeUrls: [],
  maxGuests: "",
  bedrooms: "",
  bathrooms: "",
  bedsDouble: "0",
  bedsSingle: "0",
  bedsSofa: "0",
  province: "",
  district: "",
  neighborhood: "",
  addressLine: "",
  postalCode: "",
  latitude: "",
  longitude: "",
  poolSwimming: "no",
  poolSwimmingDepth: "",
  poolSwimmingWidth: "",
  poolSwimmingLength: "",
  poolSwimmingProtected: "no",
  poolIndoor: "no",
  poolIndoorDepth: "",
  poolIndoorWidth: "",
  poolIndoorLength: "",
  poolKids: "no",
  poolKidsDepth: "",
  poolKidsWidth: "",
  poolKidsLength: "",
};

type Props = {
  action: (state: PropertyFormState, data: FormData) => Promise<PropertyFormState>;
  initial: PropertyFormValues;
  submitLabel: string;
  pendingLabel: string;
  /** Staff: alanlar salt-okunur, gönder düğmesi yok. */
  readOnly?: boolean;
};

const typeOptions = PROPERTY_TYPES.map((t) => ({ value: t, label: PROPERTY_TYPE_LABELS[t] }));
const provinceOptions = TR_PROVINCES_SORTED.map((p) => ({ value: p, label: p }));

function parseCoord(v: string, min: number, max: number): number | null {
  if (!v.trim()) return null;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-5 border-t border-border pt-6 first:border-t-0 first:pt-0">
      <legend className="float-left mb-1 w-full text-base font-semibold text-navy-900">
        {title}
        {description ? (
          <span className="mt-0.5 block text-sm font-normal text-muted-foreground">
            {description}
          </span>
        ) : null}
      </legend>
      <div className="clear-left flex flex-col gap-5">{children}</div>
    </fieldset>
  );
}

export function PropertyForm({ action, initial, submitLabel, pendingLabel, readOnly }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values ?? initial;
  const fe = state.fieldErrors ?? {};
  // Yalnız "Haritada aç" bağlantısını canlı göstermek için izlenir; değerler formdan gönderilir.
  const [lat, setLat] = useState(v.latitude);
  const [lng, setLng] = useState(v.longitude);
  const la = parseCoord(lat, -90, 90);
  const lo = parseCoord(lng, -180, 180);

  return (
    <form action={formAction} noValidate className="flex flex-col gap-6">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.saved ? <Alert tone="success">Değişiklikler kaydedildi.</Alert> : null}

      <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-8">
        <Section title="Temel bilgiler">
          <Field
            id="name"
            name="name"
            label="Mülk adı"
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
            label="T.C. Kültür ve Turizm Bakanlığı Belge No (isteğe bağlı)"
            maxLength={L.licenseMax}
            autoComplete="off"
            defaultValue={v.tourismLicenseNo}
            error={fe.tourismLicenseNo}
          />
          <RichTextEditor
            // Sunucunun döndürdüğü (temizlenmiş) açıklama farklıysa düzenleyici onunla yeniden kurulur.
            key={v.description}
            id="description"
            name="description"
            label="Açıklama (isteğe bağlı)"
            defaultHtml={v.description}
            maxText={L.descriptionMax}
            error={fe.description}
            readOnly={readOnly}
          />
        </Section>

        <Section title="Kapasite">
          <div className="grid gap-5 sm:grid-cols-3">
            <Field
              id="maxGuests"
              name="maxGuests"
              type="number"
              inputMode="numeric"
              min={L.guestsMin}
              max={L.guestsMax}
              label="Kişi kapasitesi"
              defaultValue={v.maxGuests}
              error={fe.maxGuests}
              required
            />
            <Field
              id="bedrooms"
              name="bedrooms"
              type="number"
              inputMode="numeric"
              min={0}
              max={L.roomsMax}
              label="Yatak odası"
              defaultValue={v.bedrooms}
              error={fe.bedrooms}
              required
            />
            <Field
              id="bathrooms"
              name="bathrooms"
              type="number"
              inputMode="numeric"
              min={0}
              max={L.roomsMax}
              label="Banyo"
              defaultValue={v.bathrooms}
              error={fe.bathrooms}
              required
            />
          </div>
          <div className="grid gap-5 sm:grid-cols-3">
            <Field
              id="bedsDouble"
              name="bedsDouble"
              type="number"
              inputMode="numeric"
              min={0}
              max={L.bedsMax}
              label="Çift kişilik yatak"
              defaultValue={v.bedsDouble}
              error={fe.bedsDouble}
            />
            <Field
              id="bedsSingle"
              name="bedsSingle"
              type="number"
              inputMode="numeric"
              min={0}
              max={L.bedsMax}
              label="Tek kişilik yatak"
              defaultValue={v.bedsSingle}
              error={fe.bedsSingle}
            />
            <Field
              id="bedsSofa"
              name="bedsSofa"
              type="number"
              inputMode="numeric"
              min={0}
              max={L.bedsMax}
              label="Çekyat / kanepe yatak"
              defaultValue={v.bedsSofa}
              error={fe.bedsSofa}
            />
          </div>
        </Section>

        <Section title="Havuz Bilgileri" description="Havuz tiplerini ve ölçülerini gir.">
          <PoolFields values={v} errors={fe} readOnly={readOnly} />
        </Section>

        <Section title="Adres ve konum">
          <div className="grid gap-5 sm:grid-cols-2">
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
          <div className="grid gap-5 sm:grid-cols-[2fr_1fr]">
            <Field
              id="neighborhood"
              name="neighborhood"
              label="Mahalle / köy (isteğe bağlı)"
              maxLength={L.neighborhoodMax}
              defaultValue={v.neighborhood}
              error={fe.neighborhood}
            />
            <Field
              id="postalCode"
              name="postalCode"
              label="Posta kodu (isteğe bağlı)"
              inputMode="numeric"
              maxLength={5}
              defaultValue={v.postalCode}
              error={fe.postalCode}
            />
          </div>
          <TextareaField
            id="addressLine"
            name="addressLine"
            label="Açık adres (isteğe bağlı)"
            maxLength={L.addressMax}
            className="min-h-20"
            defaultValue={v.addressLine}
            error={fe.addressLine}
          />
          <div className="grid gap-5 sm:grid-cols-2">
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
          <p className="text-sm text-muted-foreground">
            Koordinatları harita uygulamasından kopyalayabilirsiniz.{" "}
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
        </Section>

        <Section title="YouTube videoları">
          <YoutubeField initial={v.youtubeUrls} errors={fe} readOnly={readOnly} />
        </Section>
      </fieldset>

      {readOnly ? null : (
        <div className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:justify-end">
          <Button type="submit" className="w-full sm:w-auto" disabled={pending}>
            {pending ? pendingLabel : submitLabel}
          </Button>
        </div>
      )}
    </form>
  );
}
