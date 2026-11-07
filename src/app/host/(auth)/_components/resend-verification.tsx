"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";
import { AUTH_PATHS, authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-messages";

import { checkEmail } from "./form-utils";

type Props = {
  /** Biliniyorsa e-posta alanı gösterilmez (ör. kayıt veya giriş sonrası). */
  email?: string;
  variant?: "button" | "form";
};

/**
 * Doğrulama e-postasını yeniden ister. Yanıt, adresin kayıtlı olup olmamasından bağımsız aynıdır.
 */
export function ResendVerification({ email: knownEmail, variant = "button" }: Props) {
  const hydrated = useHydrated();
  const [state, setState] = useState<"idle" | "pending" | "sent">("idle");
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<string>();

  async function send(email: string) {
    setError(undefined);
    setState("pending");
    const { error: err } = await authClient.sendVerificationEmail({
      email: email.trim(),
      callbackURL: AUTH_PATHS.verifyCallback,
    });
    if (err) {
      setError(authErrorMessage(err));
      setState("idle");
      return;
    }
    setState("sent");
  }

  if (state === "sent") {
    return (
      <Alert tone="success">
        Bu adres kayıtlı ve henüz doğrulanmamışsa yeni bir doğrulama bağlantısı gönderildi. Bağlantı
        1 saat geçerlidir.
      </Alert>
    );
  }

  if (variant === "button" && knownEmail) {
    return (
      <div className="flex flex-col gap-3">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Button
          variant="secondary"
          className="w-full"
          disabled={!hydrated || state === "pending"}
          onClick={() => send(knownEmail)}
        >
          {state === "pending" ? "Gönderiliyor…" : "Doğrulama e-postasını yeniden gönder"}
        </Button>
      </div>
    );
  }

  return (
    <form
      method="post"
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const email = String(new FormData(e.currentTarget).get("email") ?? "");
        const problem = checkEmail(email);
        setFieldError(problem);
        if (!problem) void send(email);
      }}
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field
        id="resend-email"
        name="email"
        type="email"
        label="E-posta"
        autoComplete="email"
        inputMode="email"
        defaultValue={knownEmail}
        error={fieldError}
        required
      />
      <Button type="submit" className="w-full" disabled={!hydrated || state === "pending"}>
        {state === "pending" ? "Gönderiliyor…" : "Doğrulama bağlantısı gönder"}
      </Button>
    </form>
  );
}
