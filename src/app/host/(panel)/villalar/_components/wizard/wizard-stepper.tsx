import Link from "next/link";

import {
  stepHref,
  stepIndex,
  WIZARD_STEP_LABELS,
  WIZARD_STEPS,
  type WizardStep,
} from "@/lib/property-wizard";
import { cn } from "@/lib/utils";

type Props = {
  /** Yeni mülkte (henüz kayıt yok) yalnız 1. adım açıktır. */
  propertyId: string | null;
  current: WizardStep;
};

/**
 * Adım göstergesi. Masaüstünde beş adımın tamamı (kayıtlı mülkte her biri bağlantı); mobilde
 * "Adım 2/5" ve dilimli ilerleme çubuğu (satır içi stil yok: CSP).
 */
export function WizardStepper({ propertyId, current }: Props) {
  const at = stepIndex(current);
  const total = WIZARD_STEPS.length;
  return (
    <nav aria-label="Bilgi adımları" data-testid="wizard-stepper">
      <div className="flex flex-col gap-2 sm:hidden" data-testid="wizard-stepper-mobile">
        <p className="flex items-baseline justify-between gap-3 text-sm">
          <span className="font-semibold text-navy-900">
            Adım {at + 1}/{total}
          </span>
          <span className="truncate text-muted-foreground">{WIZARD_STEP_LABELS[current]}</span>
        </p>
        <div
          role="progressbar"
          aria-label="İlerleme"
          aria-valuemin={1}
          aria-valuemax={total}
          aria-valuenow={at + 1}
          aria-valuetext={`Adım ${at + 1}/${total}: ${WIZARD_STEP_LABELS[current]}`}
          className="flex gap-1"
        >
          {WIZARD_STEPS.map((s, i) => (
            <span
              key={s}
              className={cn(
                "h-1.5 flex-1 rounded-full",
                i <= at ? "bg-turquoise-500" : "bg-border",
              )}
            />
          ))}
        </div>
      </div>

      <ol className="hidden gap-2 sm:grid sm:grid-cols-5" data-testid="wizard-stepper-desktop">
        {WIZARD_STEPS.map((s, i) => {
          const isCurrent = s === current;
          // Önceki adımlar yalnız renkle ayrılır; "tamamlandı" işareti konmaz (eksikler 5. adımda).
          const done = i < at;
          const inner = (
            <>
              <span
                aria-hidden
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-bold",
                  isCurrent
                    ? "border-navy-900 bg-navy-900 text-white"
                    : done
                      ? "border-turquoise-500 bg-turquoise-50 text-turquoise-700"
                      : "border-border bg-white text-muted-foreground",
                )}
              >
                {i + 1}
              </span>
              <span className="text-[13px] leading-tight font-semibold">
                <span className="sr-only">Adım {i + 1}: </span>
                {WIZARD_STEP_LABELS[s]}
              </span>
            </>
          );
          const cls = cn(
            "flex h-full flex-col items-start gap-2 rounded-xl border-t-2 px-1 pt-3 transition-colors",
            isCurrent ? "border-navy-900 text-navy-900" : "border-border text-muted-foreground",
          );
          return (
            <li key={s}>
              {propertyId && !isCurrent ? (
                <Link href={stepHref(propertyId, s)} className={cn(cls, "hover:text-navy-900")}>
                  {inner}
                </Link>
              ) : (
                <span
                  className={cls}
                  aria-current={isCurrent ? "step" : undefined}
                  aria-disabled={isCurrent ? undefined : true}
                >
                  {inner}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
