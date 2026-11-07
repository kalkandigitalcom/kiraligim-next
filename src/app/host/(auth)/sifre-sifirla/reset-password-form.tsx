"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage, PASSWORD_MIN } from "@/lib/auth-messages";

import { checkNewPassword, formText } from "../_components/form-utils";

type FieldErrors = { password?: string | undefined; confirm?: string | undefined };

export function ResetPasswordForm({ token }: { token: string }) {
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const password = formText(data, "password");
    const confirm = formText(data, "confirm");
    const errors: FieldErrors = {
      password: checkNewPassword(password),
      confirm: confirm === password ? undefined : "Şifreler eşleşmiyor.",
    };
    setFieldErrors(errors);
    setError(undefined);
    if (errors.password || errors.confirm) return;

    setPending(true);
    const { error: err } = await authClient.resetPassword({ newPassword: password, token });
    if (err) {
      setError(authErrorMessage(err));
      setPending(false);
      return;
    }
    // Tüm oturumlar kapatıldı (revokeSessionsOnPasswordReset); yeni şifreyle giriş istenir.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- oturum değişti: istemci önbelleği tamamen atılsın, sunucu yeni çerezle render etsin.
    window.location.assign("/giris?sifre=yenilendi");
  }

  return (
    <form method="post" noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field
        id="password"
        name="password"
        type="password"
        label="Yeni şifre"
        autoComplete="new-password"
        hint={`En az ${PASSWORD_MIN} karakter.`}
        error={fieldErrors.password}
        required
      />
      <Field
        id="confirm"
        name="confirm"
        type="password"
        label="Yeni şifre (tekrar)"
        autoComplete="new-password"
        error={fieldErrors.confirm}
        required
      />
      <Button type="submit" className="w-full" disabled={!hydrated || pending}>
        {pending ? "Kaydediliyor…" : "Şifreyi güncelle"}
      </Button>
    </form>
  );
}
