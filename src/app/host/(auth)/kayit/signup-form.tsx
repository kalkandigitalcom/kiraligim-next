"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";
import { AUTH_PATHS, authClient } from "@/lib/auth-client";
import { authErrorMessage, PASSWORD_MIN } from "@/lib/auth-messages";

import { checkEmail, checkNewPassword, formText } from "../_components/form-utils";
import { ResendVerification } from "../_components/resend-verification";

type FieldErrors = Partial<Record<"name" | "email" | "password" | "confirm", string | undefined>>;

export function SignupForm({ devNotice }: { devNotice?: React.ReactNode }) {
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submittedEmail, setSubmittedEmail] = useState<string>();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const name = formText(data, "name").trim();
    const email = formText(data, "email").trim();
    const password = formText(data, "password");
    const confirm = formText(data, "confirm");
    const errors: FieldErrors = {
      name:
        name.length < 2
          ? "Adınızı ve soyadınızı girin."
          : name.length > 100
            ? "En fazla 100 karakter."
            : undefined,
      email: checkEmail(email),
      password: checkNewPassword(password),
      confirm: confirm === password ? undefined : "Şifreler eşleşmiyor.",
    };
    setFieldErrors(errors);
    setError(undefined);
    if (Object.values(errors).some(Boolean)) return;

    setPending(true);
    const { error: err } = await authClient.signUp.email({
      name,
      email,
      password,
      callbackURL: AUTH_PATHS.verifyCallback,
    });
    setPending(false);
    if (err) {
      setError(authErrorMessage(err));
      return;
    }
    setSubmittedEmail(email);
  }

  if (submittedEmail) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="success" title="E-postanızı kontrol edin">
          Kaydınızı aldık. Hesabınızı etkinleştirmek için <strong>{submittedEmail}</strong> adresine
          gelen doğrulama bağlantısına tıklayın. Bağlantı 1 saat geçerlidir.
        </Alert>
        {devNotice}
        <p className="text-sm text-muted-foreground">
          E-posta birkaç dakika içinde gelmezse istenmeyen (spam) klasörünü kontrol edin veya
          yeniden gönderin.
        </p>
        <ResendVerification email={submittedEmail} />
      </div>
    );
  }

  return (
    <form method="post" noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field
        id="name"
        name="name"
        label="Ad soyad"
        autoComplete="name"
        maxLength={100}
        error={fieldErrors.name}
        required
      />
      <Field
        id="email"
        name="email"
        type="email"
        label="E-posta"
        autoComplete="email"
        inputMode="email"
        error={fieldErrors.email}
        required
      />
      <Field
        id="password"
        name="password"
        type="password"
        label="Şifre"
        autoComplete="new-password"
        hint={`En az ${PASSWORD_MIN} karakter. Başka sitelerde kullanmadığınız bir şifre seçin.`}
        error={fieldErrors.password}
        required
      />
      <Field
        id="confirm"
        name="confirm"
        type="password"
        label="Şifre (tekrar)"
        autoComplete="new-password"
        error={fieldErrors.confirm}
        required
      />
      <Button type="submit" className="mt-1 w-full" disabled={!hydrated || pending}>
        {pending ? "Hesap oluşturuluyor…" : "Hesap oluştur"}
      </Button>
    </form>
  );
}
