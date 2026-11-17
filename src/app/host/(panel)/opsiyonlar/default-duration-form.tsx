"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";

import type { OptionDefaultFormState } from "./actions";

/** İşletmenin varsayılan opsiyon süresi (yalnız işletme sahibine gösterilir). */
export function DefaultDurationForm({
  action,
  initial,
  systemLabel,
}: {
  action: (state: OptionDefaultFormState, data: FormData) => Promise<OptionDefaultFormState>;
  initial: string;
  systemLabel: string;
}) {
  const hydrated = useHydrated();
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-start" noValidate>
      <div className="flex-1">
        <Field
          id="defaultDuration"
          name="defaultDuration"
          label="Varsayılan opsiyon süresi"
          defaultValue={state.value ?? initial}
          error={state.fieldError}
          placeholder={`boş: sistem varsayılanı (${systemLabel})`}
          maxLength={8}
          hint="Saat (ör. 24) ya da gün (ör. 2g), 1 saat – 14 gün. Boş bırakırsanız sistem varsayılanı kullanılır."
        />
      </div>
      <Button type="submit" className="sm:mt-7" disabled={!hydrated || pending}>
        {pending ? "Kaydediliyor…" : "Kaydet"}
      </Button>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
    </form>
  );
}
