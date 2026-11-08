import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { ALLOWANCE_MESSAGES } from "@/server/billing/entitlements";
import { canManageProperties, getPropertyUsage } from "@/server/properties/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import {
  EMPTY_PROPERTY_VALUES,
  WIZARD_STEP_INTROS,
  WIZARD_STEP_LABELS,
} from "@/lib/property-wizard";

import { createPropertyAction } from "../actions";
import { UsageMeter } from "../_components/property-bits";
import { BasicsStep } from "../_components/wizard/basics-step";
import { WizardStepper } from "../_components/wizard/wizard-stepper";

export const metadata: Metadata = { title: "Yeni mülk" };

export default async function NewPropertyPage() {
  const { usage, canManage } = await withPanelTenant(async (tx, ctx) => ({
    usage: await getPropertyUsage(tx),
    canManage: canManageProperties(ctx.role),
  }));

  const back = (
    <Link href="/villalar" className="text-sm font-medium text-turquoise-700 hover:underline">
      ← Mülkler
    </Link>
  );

  // Yetki ve limit burada yalnız arayüz içindir; action ve veritabanı yeniden denetler.
  if (!canManage || !usage.allowed) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        {back}
        <h1 className="text-2xl font-bold tracking-tight text-navy-900">Yeni mülk</h1>
        <Alert tone="info">
          {!canManage
            ? "Mülk ekleme yetkisi işletme sahibi ve yöneticilerdedir."
            : ALLOWANCE_MESSAGES[usage.allowed ? "limit_reached" : usage.reason]}
        </Alert>
        <Link
          href="/villalar"
          className={buttonVariants({ variant: "secondary", className: "self-start" })}
        >
          Mülklere dön
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      {back}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">Yeni mülk</h1>
        <UsageMeter usage={usage} />
      </div>
      <WizardStepper propertyId={null} current="temel" />
      <div>
        <h2 className="text-xl font-bold tracking-tight text-navy-900" data-testid="step-title">
          <span className="sr-only">Adım 1/5: </span>
          {WIZARD_STEP_LABELS.temel}
        </h2>
        <p className="mt-1 text-[15px] text-muted-foreground">
          {WIZARD_STEP_INTROS.temel} Diğer bilgileri sonraki adımlarda ekleyeceksiniz.
        </p>
      </div>
      <div className="flex flex-col gap-6">
        <BasicsStep
          action={createPropertyAction}
          initial={EMPTY_PROPERTY_VALUES}
          readOnly={false}
          prevHref={null}
          nextHref={null}
          cancel={{ href: "/villalar", label: "Vazgeç" }}
        />
      </div>
    </div>
  );
}
