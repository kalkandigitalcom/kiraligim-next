"use client";

import { Field, TextareaField } from "@/components/ui/field";
import { PUBLIC_PROFILE_LIMITS as L } from "@/lib/public-profile-meta";

import type { WizardValues } from "../../actions";
import { StepCard } from "./step-card";
import { type WizardAction, WizardFooter, WizardForm, useWizardForm } from "./wizard-form";

export type StayValues = Pick<
  WizardValues,
  "checkInTime" | "checkOutTime" | "houseRules" | "cancellationPolicy" | "paymentTerms"
>;

type Props = {
  action: WizardAction;
  initial: StayValues;
  readOnly: boolean;
  prevHref: string | null;
  nextHref: string | null;
};

/** 4. adım: giriş-çıkış saatleri, ev kuralları, iptal ve ödeme koşulları. */
export function StayStep({ action, initial, readOnly, prevHref, nextHref }: Props) {
  const { state, formAction, pending, v, fe } = useWizardForm(action, initial);
  return (
    <>
      <WizardForm
        id="wizard-form"
        step="konaklama"
        state={state}
        formAction={formAction}
        readOnly={readOnly}
      >
        <StepCard id="saat-baslik" title="Giriş ve çıkış saatleri">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="checkInTime"
              name="checkInTime"
              type="time"
              label="Giriş saati (isteğe bağlı)"
              defaultValue={v.checkInTime}
              error={fe.checkInTime}
              hint="Ör. 16:00"
            />
            <Field
              id="checkOutTime"
              name="checkOutTime"
              type="time"
              label="Çıkış saati (isteğe bağlı)"
              defaultValue={v.checkOutTime}
              error={fe.checkOutTime}
              hint="Ör. 10:00"
            />
          </div>
        </StepCard>
        <StepCard
          id="kural-baslik"
          title="Kurallar ve koşullar"
          description="Bu metinler villa sayfasında misafire aynen gösterilir."
        >
          <TextareaField
            id="houseRules"
            name="houseRules"
            label="Ev kuralları (isteğe bağlı)"
            defaultValue={v.houseRules}
            maxLength={L.houseRulesMax}
            error={fe.houseRules}
            placeholder="Ör. Evcil hayvan kabul edilmez. 23:00'ten sonra yüksek sesle müzik yapılmaz."
          />
          <TextareaField
            id="cancellationPolicy"
            name="cancellationPolicy"
            label="İptal koşulları (isteğe bağlı)"
            defaultValue={v.cancellationPolicy}
            maxLength={L.cancellationPolicyMax}
            error={fe.cancellationPolicy}
            placeholder="Ör. Girişten 30 gün öncesine kadar yapılan iptallerde ön ödeme iade edilir."
          />
          <TextareaField
            id="paymentTerms"
            name="paymentTerms"
            label="Ön ödeme ve ödeme koşulları (isteğe bağlı)"
            defaultValue={v.paymentTerms}
            maxLength={L.paymentTermsMax}
            error={fe.paymentTerms}
            placeholder="Ör. Rezervasyon onayında toplam tutarın %30'u ön ödeme olarak alınır."
          />
        </StepCard>
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
