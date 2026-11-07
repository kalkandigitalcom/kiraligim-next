import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getSessionUser } from "@/server/auth/session";
import { getAuthStatus } from "@/server/auth/status";

import { AuthCard, AuthUnavailable, DevEmailNotice } from "../_components/auth-card";
import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = { title: "Şifremi unuttum" };

export default async function ForgotPasswordPage() {
  const status = getAuthStatus();
  if (!status.available) return <AuthUnavailable />;
  if (await getSessionUser()) redirect("/");

  return (
    <AuthCard
      title="Şifrenizi mi unuttunuz?"
      description="Hesabınızın e-posta adresini girin; şifre sıfırlama bağlantısı gönderelim."
      footer={
        <Link href="/giris" className="font-semibold text-turquoise-700 hover:underline">
          Giriş sayfasına dön
        </Link>
      }
    >
      <ForgotPasswordForm devNotice={<DevEmailNotice delivery={status.emailDelivery} />} />
    </AuthCard>
  );
}
