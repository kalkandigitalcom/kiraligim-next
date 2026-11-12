"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";

import type { SecretState } from "./actions";

/** Gizli değer yalnız bu yanıtta görünür; sayfa yenilenince kaybolur (saklanmaz). */
function SecretBox({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-turquoise-500 bg-turquoise-50 px-4 py-3"
      data-testid="admin-api-secret"
    >
      <p className="text-sm font-semibold text-navy-900">{label}</p>
      <code className="font-mono text-sm break-all text-navy-900 select-all">{value}</code>
      <p className="text-sm text-muted-foreground">{note}</p>
    </div>
  );
}

export function CreateKeyForm({
  action,
  errors,
  disabled,
}: {
  action: (state: SecretState, data: FormData) => Promise<SecretState>;
  errors: Record<string, string>;
  disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const hydrated = useHydrated();
  return (
    <form action={formAction} className="flex flex-col gap-3" data-testid="admin-api-key-form">
      {state.secret ? (
        <SecretBox
          label="Yeni API anahtarı"
          value={state.secret}
          note="Bu anahtar yalnız şimdi gösteriliyor ve hiçbir yerde saklanmıyor. Kopyalayıp acenteye güvenli bir kanaldan iletin; kaybolursa geri alıp yenisini oluşturun."
        />
      ) : null}
      {state.error ? <Alert tone="error">{errors[state.error] ?? errors.error}</Alert> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Field
            id="key-label"
            name="label"
            label="Etiket (isteğe bağlı)"
            maxLength={60}
            placeholder="Örn. Canlı sunucu"
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={pending || !hydrated || disabled}>
          {pending ? "Oluşturuluyor…" : "Yeni anahtar oluştur"}
        </Button>
      </div>
    </form>
  );
}

export function AccessCodeForm({
  action,
  errors,
  disabled,
  hasCode,
}: {
  action: (state: SecretState) => Promise<SecretState>;
  errors: Record<string, string>;
  disabled: boolean;
  hasCode: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const hydrated = useHydrated();
  return (
    <form action={formAction} className="flex flex-col gap-3" data-testid="admin-api-code-form">
      {state.secret ? (
        <SecretBox
          label="Yeni erişim kodu"
          value={state.secret}
          note="Kod yalnız şimdi gösteriliyor. Acente bu kodu ev sahiplerine verir; ev sahibi villa sayfasında girip acente adını görerek onaylar. Önceki kod artık çalışmaz; verilmiş izinler etkilenmez."
        />
      ) : null}
      {state.error ? <Alert tone="error">{errors[state.error] ?? errors.error}</Alert> : null}
      <div>
        <Button type="submit" variant="secondary" disabled={pending || !hydrated || disabled}>
          {pending ? "Oluşturuluyor…" : hasCode ? "Kodu yenile" : "Erişim kodu oluştur"}
        </Button>
      </div>
    </form>
  );
}
