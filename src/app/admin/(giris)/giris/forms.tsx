"use client";

import { useActionState, useEffect } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";

import { adminLoginAction, type AdminLoginState, adminVerifyAction } from "./actions";

export function AdminLoginForm() {
  const hydrated = useHydrated();
  const [state, action, pending] = useActionState<AdminLoginState, FormData>(adminLoginAction, {});
  return (
    <form action={action} className="flex flex-col gap-5" data-testid="admin-login">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <Field
        id="email"
        name="email"
        type="email"
        label="E-posta"
        autoComplete="username"
        inputMode="email"
        defaultValue={state.email ?? ""}
        required
      />
      <Field
        id="password"
        name="password"
        type="password"
        label="Şifre"
        autoComplete="current-password"
        required
      />
      <Button type="submit" disabled={pending || !hydrated}>
        {pending ? "Denetleniyor…" : "Devam et"}
      </Button>
    </form>
  );
}

export function AdminVerifyForm() {
  const hydrated = useHydrated();
  const [state, action, pending] = useActionState<AdminLoginState, FormData>(adminVerifyAction, {});
  useEffect(() => {
    // Oturum açıldı: istemci önbelleği atılsın, sunucu yeni çerezle ve yüzey yönlendirmesinden
    // geçerek render etsin.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- tam sayfa geçiş bilinçli
    if (state.signedIn) window.location.assign("/");
  }, [state.signedIn]);
  return (
    <form action={action} className="flex flex-col gap-5" data-testid="admin-verify">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <Field
        id="code"
        name="code"
        label="Doğrulama kodu"
        hint="Kimlik doğrulama uygulamanızdaki 6 haneli kod."
        autoComplete="one-time-code"
        inputMode="numeric"
        pattern="[0-9 ]{6,7}"
        maxLength={7}
        required
        autoFocus
      />
      <Button type="submit" disabled={pending || !hydrated || state.signedIn === true}>
        {pending || state.signedIn ? "Denetleniyor…" : "Giriş yap"}
      </Button>
    </form>
  );
}
