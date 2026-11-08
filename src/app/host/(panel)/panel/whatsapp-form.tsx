"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";

import type { WhatsappFormState } from "./actions";

/** İşletme WhatsApp numarası formu (yalnız owner'a gösterilir). Boş bırakılırsa numara kaldırılır. */
export function WhatsappForm({
  action,
  initial,
}: {
  action: (state: WhatsappFormState, data: FormData) => Promise<WhatsappFormState>;
  initial: string;
}) {
  const hydrated = useHydrated();
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-start" noValidate>
      <div className="flex-1">
        <Field
          id="whatsapp"
          name="whatsapp"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          label="WhatsApp numarası"
          defaultValue={state.value ?? initial}
          error={state.fieldError}
          placeholder="0532 123 45 67"
          hint="Villa sayfalarınızda müşterilerin size yazacağı numara. Boş bırakırsanız kaldırılır."
        />
      </div>
      <Button type="submit" className="sm:mt-7" disabled={!hydrated || pending}>
        {pending ? "Kaydediliyor…" : "Kaydet"}
      </Button>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
    </form>
  );
}
