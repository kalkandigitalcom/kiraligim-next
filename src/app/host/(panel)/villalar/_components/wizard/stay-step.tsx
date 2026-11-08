"use client";

import { ListChecks, ReceiptText } from "lucide-react";

import { Field, TextareaField } from "@/components/ui/field";
import { PUBLIC_PROFILE_LIMITS as L } from "@/lib/public-profile-meta";
import { HOUSE_RULES, PRICE_INCLUDES } from "@/lib/villa-extras";

import type { WizardValues } from "../../actions";
import { BulkSelect, ChoiceCards } from "./choice-cards";
import { StepCard } from "./step-card";
import { type WizardAction, WizardFooter, WizardForm, useWizardForm } from "./wizard-form";

export type StayValues = Pick<
  WizardValues,
  "checkInTime" | "checkOutTime" | "houseRuleKeys" | "houseRules" | "priceIncludes"
>;

type Props = {
  action: WizardAction;
  initial: StayValues;
  readOnly: boolean;
  prevHref: string | null;
  nextHref: string | null;
};

/**
 * 4. adım: giriş-çıkış saatleri, ev kuralları (hazır seçenekler + ek not) ve fiyata dahil olanlar;
 * iki seçim grubunda da "Tümünü Seç / Tümünü Kaldır". (Revizyon 2: iptal ve ödeme koşulları
 * kaldırıldı.)
 */
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
          title="Ev kuralları"
          icon={<ListChecks className="size-4" />}
          description="Villanız için geçerli olanları işaretleyin. Seçtikleriniz villa sayfasında listelenir."
          aside={<BulkSelect group="houseRuleKeys" label="Ev kuralları" disabled={readOnly} />}
        >
          <ChoiceCards
            name="houseRuleKeys"
            options={HOUSE_RULES}
            selected={v.houseRuleKeys}
            labelledBy="kural-baslik"
            group="houseRuleKeys"
          />
          {fe.houseRuleKeys ? <p className="text-sm text-destructive">{fe.houseRuleKeys}</p> : null}
          <TextareaField
            id="houseRules"
            name="houseRules"
            label="Ek not (isteğe bağlı)"
            defaultValue={v.houseRules}
            maxLength={L.houseRulesMax}
            error={fe.houseRules}
            className="min-h-20"
            placeholder="Ör. Sessizlik saatleri 23:00–08:00 arasıdır."
          />
        </StepCard>

        <StepCard
          id="dahil-baslik"
          title="Fiyata dahil olanlar"
          icon={<ReceiptText className="size-4" />}
          description="Bilgi amaçlıdır; fiyat hesabını değiştirmez."
          aside={
            <BulkSelect group="priceIncludes" label="Fiyata dahil olanlar" disabled={readOnly} />
          }
        >
          <ChoiceCards
            name="priceIncludes"
            options={PRICE_INCLUDES}
            selected={v.priceIncludes}
            labelledBy="dahil-baslik"
            group="priceIncludes"
          />
          {fe.priceIncludes ? <p className="text-sm text-destructive">{fe.priceIncludes}</p> : null}
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
