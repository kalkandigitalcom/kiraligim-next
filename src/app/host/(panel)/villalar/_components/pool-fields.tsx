"use client";

import { useState } from "react";

import { Field } from "@/components/ui/field";
import { POOL_KINDS, POOL_LABELS, type PoolKind } from "@/lib/property-meta";
import { cn } from "@/lib/utils";

export type PoolFormValues = Record<
  | "poolSwimming"
  | "poolSwimmingDepth"
  | "poolSwimmingWidth"
  | "poolSwimmingLength"
  | "poolSwimmingProtected"
  | "poolIndoor"
  | "poolIndoorDepth"
  | "poolIndoorWidth"
  | "poolIndoorLength"
  | "poolKids"
  | "poolKidsDepth"
  | "poolKidsWidth"
  | "poolKidsLength",
  string
>;

const KEY = { swimming: "Swimming", indoor: "Indoor", kids: "Kids" } as const;
const DIMS = [
  ["Depth", "Derinlik (m)"],
  ["Width", "Genişlik (m)"],
  ["Length", "Uzunluk (m)"],
] as const;

type Props = {
  values: PoolFormValues;
  errors: Record<string, string>;
  readOnly?: boolean;
};

/** İki seçenekli düğme grubu (Var/Yok, Evet/Hayır): yerel radyo düğmeleri, klavye ile seçilir. */
function Choice({
  name,
  legend,
  value,
  options,
  onChange,
}: {
  name: string;
  legend: string;
  value: string;
  options: readonly [string, string][];
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
              "flex h-9 min-w-16 cursor-pointer items-center justify-center rounded-md px-3 text-sm font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-turquoise-500/50 has-disabled:cursor-not-allowed",
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

/**
 * Havuz bilgileri: her havuz için Var/Yok. "Var" seçilince ölçüler (ve yüzme havuzunda
 * "Korunaklı havuz") açılır; "Yok" iken gizlenir ve kaydedilmez (sunucu da yok sayar).
 * Gizlenen alanların değeri bellekte kalır: yanlışlıkla "Yok"a basıp geri dönmek veri kaybettirmez.
 */
export function PoolFields({ values, errors, readOnly }: Props) {
  const [present, setPresent] = useState<Record<PoolKind, string>>({
    swimming: values.poolSwimming || "no",
    indoor: values.poolIndoor || "no",
    kids: values.poolKids || "no",
  });
  const [protectedPool, setProtectedPool] = useState(values.poolSwimmingProtected || "no");

  return (
    <div className="flex flex-col gap-4">
      {POOL_KINDS.map((k) => {
        const base = `pool${KEY[k]}` as const;
        const open = present[k] === "yes";
        return (
          <div
            key={k}
            data-testid={`pool-${k}`}
            className="flex flex-col gap-4 rounded-xl border border-border bg-white/60 p-4"
          >
            <Choice
              name={base}
              legend={POOL_LABELS[k]}
              value={present[k]}
              options={[
                ["yes", "Var"],
                ["no", "Yok"],
              ]}
              onChange={(v) => setPresent((p) => ({ ...p, [k]: v }))}
            />
            <div hidden={!open} className="flex flex-col gap-4" data-testid={`pool-${k}-details`}>
              <div className="grid gap-4 sm:grid-cols-3">
                {DIMS.map(([d, label]) => {
                  const name = `${base}${d}` as keyof PoolFormValues;
                  return (
                    <Field
                      key={d}
                      id={name}
                      name={name}
                      label={label}
                      inputMode="decimal"
                      placeholder="ör. 1,50"
                      maxLength={6}
                      defaultValue={values[name]}
                      error={open ? errors[name] : undefined}
                      readOnly={readOnly}
                    />
                  );
                })}
              </div>
              {k === "swimming" ? (
                <Choice
                  name="poolSwimmingProtected"
                  legend="Korunaklı havuz"
                  value={protectedPool}
                  options={[
                    ["yes", "Evet"],
                    ["no", "Hayır"],
                  ]}
                  onChange={setProtectedPool}
                />
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
