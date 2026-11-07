"use client";

import Link from "next/link";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-messages";

import { checkEmail, formText } from "../_components/form-utils";
import { ResendVerification } from "../_components/resend-verification";

type FieldErrors = { email?: string | undefined; password?: string | undefined };

export function LoginForm() {
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [unverifiedEmail, setUnverifiedEmail] = useState<string>();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const email = formText(data, "email").trim();
    const password = formText(data, "password");
    const errors: FieldErrors = {
      email: checkEmail(email),
      password: password ? undefined : "Şifrenizi girin.",
    };
    setFieldErrors(errors);
    setError(undefined);
    setUnverifiedEmail(undefined);
    if (errors.email || errors.password) return;

    setPending(true);
    const { error: err } = await authClient.signIn.email({ email, password });
    if (err) {
      if (err.code === "EMAIL_NOT_VERIFIED") setUnverifiedEmail(email);
      else setError(authErrorMessage(err));
      setPending(false);
      return;
    }
    // Tam sayfa geçiş: sunucu yeni oturum çereziyle panel veya işletme sihirbazına yönlendirir.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- oturum değişti: istemci önbelleği tamamen atılsın, sunucu yeni çerezle render etsin.
    window.location.assign("/");
  }

  return (
    <form method="post" noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {unverifiedEmail ? (
        <div className="flex flex-col gap-3">
          <Alert tone="info" title="E-posta adresiniz doğrulanmamış">
            Giriş yapabilmek için e-postanıza gönderilen doğrulama bağlantısına tıklayın.
          </Alert>
          <ResendVerification email={unverifiedEmail} />
        </div>
      ) : null}
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
        autoComplete="current-password"
        error={fieldErrors.password}
        labelAside={
          <Link
            href="/sifremi-unuttum"
            className="text-sm font-medium text-turquoise-700 hover:underline"
          >
            Şifremi unuttum
          </Link>
        }
        required
      />
      <Button type="submit" className="mt-1 w-full" disabled={!hydrated || pending}>
        {pending ? "Giriş yapılıyor…" : "Giriş yap"}
      </Button>
    </form>
  );
}
