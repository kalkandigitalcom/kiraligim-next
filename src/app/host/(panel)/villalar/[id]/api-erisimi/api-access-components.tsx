"use client";

import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";

import type { CodeState, SimpleState } from "./actions";

type Action = (state: CodeState, data: FormData) => Promise<CodeState>;

/**
 * İki adım: (1) acente kodu → acente adı gösterilir; (2) ev sahibi adı görüp onaylar → izin.
 * Kod yalnız form alanında taşınır (URL'ye yazılmaz).
 */
export function GrantFlow(props: { lookup: Action; confirm: Action }) {
  // "Vazgeç" akışı baştan başlatır (iki adımın durumu da sıfırlanır).
  const [run, setRun] = useState(0);
  return <GrantSteps key={run} {...props} onCancel={() => setRun((n) => n + 1)} />;
}

function GrantSteps({
  lookup,
  confirm,
  onCancel,
}: {
  lookup: Action;
  confirm: Action;
  onCancel: () => void;
}) {
  const [looked, lookupAction, lookingUp] = useActionState(lookup, {});
  const [confirmed, confirmAction, confirming] = useActionState(confirm, {});
  const hydrated = useHydrated();
  // Onay adımı: onay denemesi hata verdiyse (ör. kutu işaretlenmemiş) onun durumu, yoksa arama.
  const step = confirmed.step === "confirm" ? confirmed : looked.step === "confirm" ? looked : null;

  if (step) {
    return (
      <form
        action={confirmAction}
        className="flex flex-col gap-4"
        aria-label="Acente erişimini onayla"
        data-testid="api-grant-confirm"
      >
        {confirmed.error ? <Alert tone="error">{confirmed.error}</Alert> : null}
        <div className="rounded-xl border border-border bg-mist/60 px-4 py-3">
          <p className="text-sm text-muted-foreground">Erişim isteyen acente</p>
          <p className="text-lg font-semibold text-navy-900" data-testid="api-grant-client">
            {step.clientName}
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          Bu acente, bu villanın yalnız <strong>adını</strong> ve <strong>dolu tarihlerini</strong>{" "}
          görebilir. Fiyat, misafir bilgisi, açıklama, fotoğraf, adres ve rezervasyon ayrıntısı
          paylaşılmaz. Erişimi istediğiniz zaman kaldırabilirsiniz.
        </p>
        <input type="hidden" name="code" value={step.code ?? ""} />
        <input type="hidden" name="clientId" value={step.clientId ?? ""} />
        <input type="hidden" name="clientName" value={step.clientName ?? ""} />
        <label className="flex items-start gap-2 text-sm text-navy-900">
          <input
            type="checkbox"
            name="confirm"
            value="evet"
            className="mt-0.5 size-4 accent-navy-900"
          />
          <span>{step.clientName} acentesine bu villa için erişim veriyorum.</span>
        </label>
        <div className="flex flex-col-reverse gap-3 border-t border-border pt-4 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onCancel}>
            Vazgeç
          </Button>
          <Button type="submit" disabled={confirming || !hydrated}>
            {confirming ? "Onaylanıyor…" : "Erişimi onayla"}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form
      action={lookupAction}
      noValidate
      className="flex flex-col gap-4"
      aria-label="Acente kodu gir"
      data-testid="api-grant-lookup"
    >
      {looked.error ? <Alert tone="error">{looked.error}</Alert> : null}
      <Field
        id="api-code"
        name="code"
        label="Acente erişim kodu"
        placeholder="KG-XXXX-XXXX"
        maxLength={20}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="characters"
        required
        hint="Kodu çalıştığınız acente verir. Kodu girdikten sonra acentenin adını görür ve onaylarsınız."
      />
      <div className="flex justify-end border-t border-border pt-4">
        <Button type="submit" className="w-full sm:w-auto" disabled={lookingUp || !hydrated}>
          {lookingUp ? "Kontrol ediliyor…" : "Devam"}
        </Button>
      </div>
    </form>
  );
}

export function RevokeButton({
  action,
  clientName,
}: {
  action: () => Promise<SimpleState>;
  clientName: string;
}) {
  const [state, formAction, pending] = useActionState<SimpleState>(action, {});
  const hydrated = useHydrated();
  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <Button
        type="submit"
        variant="secondary"
        size="sm"
        disabled={pending || !hydrated}
        aria-label={`${clientName} erişimini kaldır`}
        data-testid="api-grant-revoke"
      >
        {pending ? "Kaldırılıyor…" : "Erişimi kaldır"}
      </Button>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
