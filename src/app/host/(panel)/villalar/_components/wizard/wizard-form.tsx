"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useActionState, useRef } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import { stepOfField, WIZARD_STEP_LABELS, type WizardStep } from "@/lib/property-wizard";

import type { WizardFormState, WizardValues } from "../../actions";
import { useUnsavedGuard } from "./use-unsaved-guard";

export type WizardAction = (state: WizardFormState, data: FormData) => Promise<WizardFormState>;

/** Adım formunun durumu: hata sonrası kullanıcının değerleri kayıtlı değerlerin üzerine konur. */
export function useWizardForm<V extends Partial<WizardValues>>(action: WizardAction, initial: V) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = { ...initial, ...state.values } as V;
  const fe = state.fieldErrors ?? {};
  return { state, formAction, pending, v, fe };
}

type FormProps = {
  id: string;
  step: WizardStep;
  state: WizardFormState;
  formAction: (data: FormData) => void;
  readOnly: boolean;
  children: React.ReactNode;
};

/**
 * Adım formu. Kaydetme düğmesi formun dışında (WizardFooter, `form` özniteliğiyle) durabilir:
 * 2. adımda fotoğraf yöneticisi formla düğme arasındadır ve kendi işlemleriyle anında kaydeder.
 */
export function WizardForm({ id, step, state, formAction, readOnly, children }: FormProps) {
  const hydrated = useHydrated();
  const ref = useRef<HTMLFormElement>(null);
  useUnsavedGuard(ref, hydrated && !readOnly, state);
  // Bu adımda gösterilmeyen bir alandaki hata (ör. eski bir kayıt bugünkü kurallara uymuyor):
  // kullanıcıya hangi adımı düzeltmesi gerektiği söylenir.
  const otherSteps = [
    ...new Set(
      Object.keys(state.fieldErrors ?? {})
        .map(stepOfField)
        .filter((s): s is NonNullable<typeof s> => s !== null && s !== step),
    ),
  ];
  return (
    <form
      id={id}
      ref={ref}
      action={formAction}
      noValidate
      className="flex flex-col gap-6"
      data-testid="wizard-form"
    >
      {state.error ? (
        <Alert tone="error">
          {state.error}
          {otherSteps.length > 0 ? (
            <>
              {" "}
              Şu bölümdeki bilgileri de kontrol edin:{" "}
              {otherSteps.map((s) => WIZARD_STEP_LABELS[s]).join(", ")}.
            </>
          ) : null}
        </Alert>
      ) : null}
      <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-6">
        {children}
      </fieldset>
    </form>
  );
}

type FooterProps = {
  formId?: string;
  prevHref: string | null;
  /** Salt okunur görünümde "Sonraki" bağlantısı. */
  nextHref: string | null;
  readOnly: boolean;
  pending?: boolean;
  /** Önceki yerine gösterilecek bağlantı (yeni mülk: "Vazgeç"). */
  cancel?: { href: string; label: string };
};

/** Önceki / Kaydet ve devam et. Mobilde ana düğme üstte ve tam genişliktedir. */
export function WizardFooter({
  formId,
  prevHref,
  nextHref,
  readOnly,
  pending,
  cancel,
}: FooterProps) {
  const hydrated = useHydrated();
  const back = prevHref
    ? { href: prevHref, label: "Önceki" }
    : cancel
      ? { href: cancel.href, label: cancel.label }
      : null;
  return (
    <div
      className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between"
      data-testid="wizard-footer"
    >
      {back ? (
        <Link
          href={back.href}
          className={buttonVariants({ variant: "secondary", className: "w-full sm:w-auto" })}
        >
          {prevHref ? <ChevronLeft aria-hidden className="size-4" /> : null}
          {back.label}
        </Link>
      ) : (
        <span className="hidden sm:block" />
      )}
      {readOnly ? (
        nextHref ? (
          <Link href={nextHref} className={buttonVariants({ className: "w-full sm:w-auto" })}>
            Sonraki
            <ChevronRight aria-hidden className="size-4" />
          </Link>
        ) : null
      ) : (
        <Button
          type="submit"
          form={formId}
          className="w-full sm:w-auto sm:min-w-48"
          disabled={!hydrated || pending}
        >
          {pending ? "Kaydediliyor…" : "Kaydet ve devam et"}
          {pending ? null : <ChevronRight aria-hidden className="size-4" />}
        </Button>
      )}
    </div>
  );
}
