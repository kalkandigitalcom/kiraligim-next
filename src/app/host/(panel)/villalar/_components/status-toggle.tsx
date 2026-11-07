"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { PropertyStatus } from "@/lib/property-meta";

import type { StatusFormState } from "../actions";

type Props = {
  status: PropertyStatus;
  action: (state: StatusFormState, data: FormData) => Promise<StatusFormState>;
};

/** Aktif ↔ pasif. Silme yoktur; pasif mülk de paket limitine dahildir. */
export function StatusToggle({ status, action }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const next: PropertyStatus = status === "active" ? "passive" : "active";
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="status" value={next} />
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <p className="text-sm text-muted-foreground">
        {status === "active"
          ? "Pasife alınan mülk listede kalır ve paket hakkınızdan düşmez; istediğiniz zaman yeniden aktif edebilirsiniz."
          : "Mülk şu an pasif. Aktif ettiğinizde yeniden kullanıma açılır."}
      </p>
      <Button
        type="submit"
        variant="secondary"
        className="w-full sm:w-auto sm:self-start"
        disabled={pending}
      >
        {pending ? "Kaydediliyor…" : status === "active" ? "Pasife al" : "Aktif et"}
      </Button>
    </form>
  );
}
