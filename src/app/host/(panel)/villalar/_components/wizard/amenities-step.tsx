"use client";

import {
  Baby,
  Bath,
  Mountain,
  ShieldCheck,
  Snowflake,
  Sun,
  Trees,
  Tv,
  UtensilsCrossed,
  Waves,
} from "lucide-react";
import { useRef, useState } from "react";

import { AMENITY_GROUPS } from "@/lib/public-profile-meta";

import type { WizardFormState, WizardValues } from "../../actions";
import { type PoolFormValues, PoolFields } from "../pool-fields";
import { BulkSelect, ChoiceCards } from "./choice-cards";
import { StepCard } from "./step-card";
import { type WizardAction, WizardFooter, WizardForm, useWizardForm } from "./wizard-form";

export type AmenitiesValues = PoolFormValues & Pick<WizardValues, "amenities">;

type Props = {
  action: WizardAction;
  initial: AmenitiesValues;
  readOnly: boolean;
  prevHref: string | null;
  nextHref: string | null;
};

const ICONS: Record<string, React.ReactNode> = {
  konfor: <Snowflake className="size-4" />,
  eglence: <Tv className="size-4" />,
  mutfak: <UtensilsCrossed className="size-4" />,
  banyo: <Bath className="size-4" />,
  havuz: <Sun className="size-4" />,
  "dis-alan": <Trees className="size-4" />,
  manzara: <Mountain className="size-4" />,
  aile: <Baby className="size-4" />,
  guvenlik: <ShieldCheck className="size-4" />,
};

/**
 * 3. adım: olanak kategorileri (kart + seçim kutuları; her kartta yalnız o kategoriyi etkileyen
 * "Tümünü Seç / Tümünü Kaldır") ve havuz bilgileri.
 * Onay kutuları kontrolsüzdür (defaultChecked): React 19 form eylemi sonrası formu sıfırlar ve
 * varsayılanları son değerlerden alır. Kart sayaçları yalnız gösterim içindir (Aşama 2 düzeltmesi).
 */
export function AmenitiesStep({ action, initial, readOnly, prevHref, nextHref }: Props) {
  const { state, formAction, pending, v, fe } = useWizardForm(action, initial);
  const rootRef = useRef<HTMLDivElement>(null);
  const [counted, setCounted] = useState<{
    for: WizardFormState;
    n: Record<string, number>;
  } | null>(null);
  const saved = (key: string) =>
    AMENITY_GROUPS.find((g) => g.key === key)!.items.filter(([k]) => v.amenities.includes(k))
      .length;
  const count = (key: string) =>
    counted && counted.for === state ? (counted.n[key] ?? 0) : saved(key);
  const recount = () => {
    const n: Record<string, number> = {};
    for (const g of AMENITY_GROUPS) {
      n[g.key] =
        rootRef.current?.querySelectorAll(`[data-group="${g.key}"] input:checked`).length ?? 0;
    }
    setCounted({ for: state, n });
  };

  return (
    <>
      <WizardForm
        id="wizard-form"
        step="olanaklar"
        state={state}
        formAction={formAction}
        readOnly={readOnly}
      >
        <div ref={rootRef} onChange={recount} className="flex flex-col gap-4">
          {AMENITY_GROUPS.map((g) => (
            <StepCard
              key={g.key}
              id={`grp-${g.key}`}
              title={g.label}
              icon={ICONS[g.key]}
              aside={
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <span
                    className="rounded-full bg-mist px-2.5 py-0.5 text-xs font-semibold text-navy-900"
                    data-testid={`count-${g.key}`}
                  >
                    {count(g.key)} seçili
                  </span>
                  <BulkSelect group={g.key} label={g.label} disabled={readOnly} onDone={recount} />
                </div>
              }
            >
              <ChoiceCards
                name="amenities"
                options={g.items}
                selected={v.amenities}
                labelledBy={`grp-${g.key}`}
                group={g.key}
              />
            </StepCard>
          ))}
          {fe.amenities ? <p className="text-sm text-destructive">{fe.amenities}</p> : null}

          <StepCard
            id="havuz-baslik"
            title="Havuz özellikleri"
            icon={<Waves className="size-4" />}
            description="Villanızdaki havuzları ve ölçülerini girin."
          >
            <PoolFields values={v} errors={fe} readOnly={readOnly} />
          </StepCard>
        </div>
      </WizardForm>
      <WizardFooter
        formId="wizard-form"
        prevHref={prevHref}
        nextHref={nextHref}
        readOnly={readOnly}
        pending={pending}
      />
    </>
  );
}
