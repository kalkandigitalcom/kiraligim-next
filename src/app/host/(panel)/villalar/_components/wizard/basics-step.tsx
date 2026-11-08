"use client";

import { CircleCheck, MapPin, Route } from "lucide-react";
import { useState } from "react";

import { Field, SelectField, TextareaField } from "@/components/ui/field";
import { MAP_INPUT_MAX, MAP_PARSE_MESSAGES, parseMapInput } from "@/lib/map-embed";
import { PROPERTY_LIMITS as L, PROPERTY_TYPE_LABELS, PROPERTY_TYPES } from "@/lib/property-meta";
import { TR_PROVINCES_SORTED } from "@/lib/tr-provinces";
import { DISTANCE_KEYS, DISTANCE_LABELS, type DistanceKey } from "@/lib/villa-extras";

import type { WizardValues } from "../../actions";
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
  | "mapLocation"
  | "maxGuests"
  | "bedrooms"
  | "bathrooms"
  | DistanceKey
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

/** Yapıştırılan harita kodunun anında kontrolü (asıl doğrulama sunucuda ve veritabanında). */
function MapStatus({ text }: { text: string }) {
  if (!text.trim()) return null;
  const r = parseMapInput(text);
  return r.ok ? (
    <p
      className="flex items-center gap-1.5 text-sm font-medium text-turquoise-700"
      data-testid="map-status"
      data-ok="true"
    >
      <CircleCheck aria-hidden className="size-4" />
      Konum tanındı. Kaydedince villa sayfanızda harita olarak görünür.
    </p>
  ) : (
    <p className="text-sm text-amber-800" data-testid="map-status" data-ok="false">
      {MAP_PARSE_MESSAGES[r.error]}
    </p>
  );
}

/** 1. adım: villa, konum ve harita, kapasite, yakın yerlere mesafeler. */
export function BasicsStep({ action, initial, readOnly, prevHref, nextHref, cancel }: Props) {
  const { state, formAction, pending, v, fe } = useWizardForm(action, initial);
  // Yalnız anında geri bildirim için izlenir; değer formdan gönderilir.
  const [mapText, setMapText] = useState(v.mapLocation);
  // Kullanıcı alanı değiştirdiyse sunucunun önceki hatası yerine anında kontrol gösterilir.
  const mapEdited = mapText !== v.mapLocation;
  const mapError = mapEdited ? undefined : fe.mapLocation;

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
          description="Villanızın yeri misafirlerinize villa sayfasında harita olarak gösterilir."
        >
          <ol className="-mt-1 flex list-decimal flex-col gap-1 pl-5 text-sm text-navy-900/80">
            <li>Google Haritalar&apos;da villanızı bulun.</li>
            <li>
              <strong>Paylaş</strong> → <strong>Haritayı yerleştir</strong>&apos;i seçin ve{" "}
              <strong>HTML&apos;yi kopyala</strong>&apos;ya basın.
            </li>
            <li>Kopyaladığınızı aşağıya yapıştırın.</li>
          </ol>
          <TextareaField
            id="mapLocation"
            name="mapLocation"
            label="Harita kodu veya bağlantısı"
            hint="Tarayıcının adres çubuğundaki Google Haritalar bağlantısını da yapıştırabilirsiniz. Haritayı kaldırmak için alanı boşaltın."
            maxLength={MAP_INPUT_MAX}
            spellCheck={false}
            autoComplete="off"
            className="min-h-24 font-mono text-[13px]"
            defaultValue={v.mapLocation}
            onChange={(e) => setMapText(e.target.value)}
            error={mapError}
            placeholder='<iframe src="https://www.google.com/maps/embed?pb=…"></iframe>'
          />
          {mapError ? null : <MapStatus text={mapText} />}
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
          description="Kilometre olarak yazın; bilmediklerinizi boş bırakın. Ör. 1,5"
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            {DISTANCE_KEYS.map((k) => (
              <Field
                key={k}
                id={k}
                name={k}
                label={`${DISTANCE_LABELS[k]} (km)`}
                inputMode="decimal"
                maxLength={8}
                autoComplete="off"
                defaultValue={v[k]}
                error={fe[k]}
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
