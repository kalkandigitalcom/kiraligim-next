"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";
import { AUTH_PATHS, authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-messages";

import { checkEmail, formText } from "../_components/form-utils";

export function ForgotPasswordForm({ devNotice }: { devNotice?: React.ReactNode }) {
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<string>();
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = formText(new FormData(e.currentTarget), "email").trim();
    const problem = checkEmail(email);
    setFieldError(problem);
    setError(undefined);
    if (problem) return;
    setPending(true);
    const { error: err } = await authClient.requestPasswordReset({
      email,
      redirectTo: AUTH_PATHS.resetCallback,
    });
    setPending(false);
    if (err) {
      setError(authErrorMessage(err));
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-4">
        {/* Hesabın var olup olmadığı açığa çıkmasın diye yanıt her durumda aynıdır. */}
        <Alert tone="success" title="Talebiniz alındı">
          Bu adrese kayıtlı bir hesap varsa şifre sıfırlama bağlantısı gönderildi. Bağlantı 1 saat
          geçerlidir.
        </Alert>
        {devNotice}
      </div>
    );
  }

  return (
    <form method="post" noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field
        id="email"
        name="email"
        type="email"
        label="E-posta"
        autoComplete="email"
        inputMode="email"
        error={fieldError}
        required
      />
      <Button type="submit" className="w-full" disabled={!hydrated || pending}>
        {pending ? "Gönderiliyor…" : "Sıfırlama bağlantısı gönder"}
      </Button>
    </form>
  );
}
