import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { authErrorMessage } from "@/lib/auth-messages";
import { getAuthStatus } from "@/server/auth/status";

import { AuthCard, AuthUnavailable } from "../_components/auth-card";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: "Yeni şifre belirle" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Sıfırlama bağlantısı Better Auth'a gider (/api/auth/reset-password/:token); Better Auth token'ı
 * kontrol edip buraya ?token=… (geçerli) veya ?error=INVALID_TOKEN ile yönlendirir.
 * Token'ın asıl doğrulaması şifre gönderilirken Better Auth'ta yapılır.
 */
export default async function ResetPasswordPage({ searchParams }: Props) {
  const status = getAuthStatus();
  if (!status.available) return <AuthUnavailable />;
  const { token, error } = await searchParams;

  if (typeof error === "string" || typeof token !== "string" || token.length < 8) {
    return (
      <AuthCard title="Bağlantı geçersiz">
        <div className="flex flex-col gap-5">
          <Alert tone="error">
            {typeof error === "string"
              ? authErrorMessage({ code: error })
              : "Şifre sıfırlama bağlantısı eksik veya hatalı."}{" "}
            Yeni bir bağlantı isteyebilirsiniz.
          </Alert>
          <Link href="/sifremi-unuttum" className={buttonVariants({ className: "w-full" })}>
            Yeni bağlantı iste
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Yeni şifre belirleyin"
      description="Şifreniz güncellendiğinde tüm cihazlardaki oturumlar kapatılır."
    >
      <ResetPasswordForm token={token} />
    </AuthCard>
  );
}
