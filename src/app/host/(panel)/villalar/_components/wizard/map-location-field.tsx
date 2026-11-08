"use client";

import { CircleCheck, Code, MapPin as MapPinIcon, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { LazyLeafletMap } from "@/components/map/lazy-leaflet-map";
import { Field, TextareaField } from "@/components/ui/field";
import { MAP_INPUT_MAX, MAP_PARSE_MESSAGES, parseMapInput } from "@/lib/map-embed";
import {
  isMapMode,
  MAP_MODE_LABELS,
  type MapMode,
  type MapPin,
  parsePinInput,
  pinToInput,
} from "@/lib/map-pin";
import { cn } from "@/lib/utils";

import type { WizardFormState } from "../../actions";

export type MapFieldValues = {
  mapMode: string;
  mapLocation: string;
  mapPinLat: string;
  mapPinLng: string;
};

type Props = {
  /** Son kayıt / gönderim değerleri (form sıfırlanınca bunlara döner). */
  v: MapFieldValues;
  fe: Partial<Record<keyof MapFieldValues, string>>;
  /** Form eyleminin son sonucu: değişince yerel seçimler kayıtlı değerlere döner. */
  state: WizardFormState;
  readOnly: boolean;
};

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

const MODE_ICONS: Record<MapMode, React.ReactNode> = {
  google: <Code aria-hidden className="size-4" />,
  pin: <MapPinIcon aria-hidden className="size-4" />,
};

const MODE_HINTS: Record<MapMode, string> = {
  google: "Google Haritalar'dan kopyaladığınız kod veya bağlantı",
  pin: "Haritaya dokunun, iğneyi sürükleyerek yerini düzeltin",
};

/**
 * Harita: iki yöntemden biri seçilir (radyo). Her iki yöntemin alanları formda kalır (gizli olan
 * da gönderilir), böylece yöntem değiştirilince diğerinin kayıtlı verisi kaybolmaz; misafire
 * yalnız seçili yöntem gösterilir (sunucu: src/server/properties/schema.ts → mapFromRaw).
 *
 * Alanlar kontrolsüzdür (React 19 form eylemi sonrası sıfırlama, Aşama 2 düzeltmesi). Haritadaki
 * tıklama/sürükleme enlem-boylam kutularına DOM üzerinden yazılır; yerel seçimler yalnız son form
 * durumu için geçerlidir ("for: state" kalıbı), sonuç değişince kayıtlı değerlere dönülür.
 */
export function MapLocationField({ v, fe, state, readOnly }: Props) {
  const latRef = useRef<HTMLInputElement>(null);
  const lngRef = useRef<HTMLInputElement>(null);

  const savedMode: MapMode = isMapMode(v.mapMode) ? v.mapMode : "google";
  const [modePick, setModePick] = useState<{ for: WizardFormState; mode: MapMode } | null>(null);
  const mode = modePick && modePick.for === state ? modePick.mode : savedMode;

  const savedPin = (() => {
    const r = parsePinInput(v.mapPinLat, v.mapPinLng);
    return r.ok ? r.pin : null;
  })();
  const [pinPick, setPinPick] = useState<{ for: WizardFormState; pin: MapPin | null } | null>(null);
  const pin = pinPick && pinPick.for === state ? pinPick.pin : savedPin;

  // Google alanı: kullanıcı alanı değiştirdiyse sunucunun önceki hatası yerine anında kontrol.
  const [mapTextPick, setMapTextPick] = useState<{ for: WizardFormState; text: string } | null>(
    null,
  );
  const mapText = mapTextPick && mapTextPick.for === state ? mapTextPick.text : v.mapLocation;
  const mapEdited = mapText !== v.mapLocation;
  const mapError = mapEdited ? undefined : fe.mapLocation;

  const pinEdited = pinPick !== null && pinPick.for === state;
  const pinError = pinEdited ? undefined : fe.mapPinLat;

  /** Haritadan gelen iğne → kutular + harita. */
  const placePin = (p: MapPin | null) => {
    if (latRef.current) latRef.current.value = p ? pinToInput(p.lat) : "";
    if (lngRef.current) lngRef.current.value = p ? pinToInput(p.lng) : "";
    setPinPick({ for: state, pin: p });
  };

  /** Kutulara yazılınca: geçerliyse haritadaki iğne taşınır (yarım/hatalı girişte dokunulmaz). */
  const onCoordInput = () => {
    const r = parsePinInput(latRef.current?.value, lngRef.current?.value);
    if (r.ok) setPinPick({ for: state, pin: r.pin });
  };

  return (
    <div className="flex flex-col gap-4">
      <fieldset
        // React form sıfırlaması radyoları yeni varsayılana döndürmeyebilir: değer değişince yeniden kur.
        key={`mapMode-${savedMode}`}
        className="grid gap-2 sm:grid-cols-2"
        data-testid="map-mode"
      >
        <legend className="sr-only">Harita yöntemi</legend>
        {(["google", "pin"] as const).map((m) => (
          <label
            key={m}
            className="flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border border-border px-3 py-2.5 text-sm text-navy-900 transition-colors hover:bg-mist has-checked:border-turquoise-500 has-checked:bg-turquoise-50 has-disabled:cursor-default"
          >
            <input
              type="radio"
              name="mapMode"
              value={m}
              defaultChecked={savedMode === m}
              onChange={() => setModePick({ for: state, mode: m })}
              className="mt-0.5 size-4 shrink-0 accent-navy-900"
              data-testid={`map-mode-${m}`}
            />
            <span className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 font-semibold">
                {MODE_ICONS[m]}
                {MAP_MODE_LABELS[m]}
              </span>
              <span className="text-muted-foreground">{MODE_HINTS[m]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {fe.mapMode ? <p className="text-sm text-destructive">{fe.mapMode}</p> : null}

      <div
        hidden={mode !== "google"}
        className={cn("flex flex-col gap-3", mode !== "google" && "hidden")}
        data-testid="map-panel-google"
      >
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-navy-900/80">
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
          onChange={(e) => setMapTextPick({ for: state, text: e.target.value })}
          error={mapError}
          placeholder='<iframe src="https://www.google.com/maps/embed?pb=…"></iframe>'
        />
        {mapError ? null : <MapStatus text={mapText} />}
      </div>

      <div
        hidden={mode !== "pin"}
        className={cn("flex flex-col gap-3", mode !== "pin" && "hidden")}
        data-testid="map-panel-pin"
      >
        <p className="text-sm text-navy-900/80">
          Haritayı yakınlaştırıp villanızın üzerine dokunun veya tıklayın; iğneyi sürükleyerek
          yerini düzeltebilirsiniz. Harita OpenStreetMap&apos;ten yüklenir. İğnenin konumu
          misafirlere villa sayfasında gösterilir.
        </p>
        <div className="relative isolate aspect-[4/3] w-full overflow-hidden rounded-2xl border border-border bg-mist sm:aspect-[16/10]">
          {/* Harita yalnız bu yöntem seçiliyken yüklenir (gizli kapsayıcıda boyut hesaplanamaz). */}
          {mode === "pin" ? (
            <LazyLeafletMap
              pin={pin}
              editable={!readOnly}
              onPinChange={(p) => placePin(p)}
              label="Villa konumu seçme haritası"
              className="size-full"
            />
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field
            ref={latRef}
            id="mapPinLat"
            name="mapPinLat"
            label="Enlem"
            inputMode="decimal"
            autoComplete="off"
            maxLength={12}
            defaultValue={v.mapPinLat}
            onChange={onCoordInput}
            error={pinError}
            placeholder="Ör. 36.2655"
          />
          <Field
            ref={lngRef}
            id="mapPinLng"
            name="mapPinLng"
            label="Boylam"
            inputMode="decimal"
            autoComplete="off"
            maxLength={12}
            defaultValue={v.mapPinLng}
            onChange={onCoordInput}
            placeholder="Ör. 29.4147"
          />
          <button
            type="button"
            onClick={() => placePin(null)}
            disabled={!pin}
            className="col-span-2 inline-flex h-11 items-center justify-center gap-1.5 rounded-lg border border-border px-3 text-sm font-semibold text-navy-900 transition-colors hover:bg-mist disabled:cursor-not-allowed disabled:opacity-50 sm:col-span-1"
            data-testid="map-pin-clear"
          >
            <Trash2 aria-hidden className="size-4" />
            İğneyi kaldır
          </button>
        </div>
        <p className="text-sm text-muted-foreground" data-testid="map-pin-status">
          {pin
            ? `İğne: ${pinToInput(pin.lat)}, ${pinToInput(pin.lng)}`
            : "Henüz iğne bırakılmadı; kaydederseniz harita gösterilmez."}
        </p>
      </div>
    </div>
  );
}
