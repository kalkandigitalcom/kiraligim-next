import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { authErrorMessage } from "@/lib/auth-messages";
import { getAuthStatus } from "@/server/auth/status";

import { AuthCard, AuthUnavailable, DevEmailNotice } from "../_components/auth-card";
import { ResendVerification } from "../_components/resend-verification";

export const metadata: Metadata = { title: "E-posta doğrulama" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Doğrulama bağlantısı Better Auth'a (/api/auth/verify-email) gider; Better Auth token'ı doğrular
 * ve buraya yönlendirir: başarıda ?durum=tamam, hatada ayrıca &error=KOD.
 * Parametresiz ziyarette yalnız "yeniden gönder" formu gösterilir (başarı iddia edilmez).
 */
export default async function VerifyEmailPage({ searchParams }: Props) {
  const status = getAuthStatus();
  if (!status.available) return <AuthUnavailable />;
  const { durum, error } = await searchParams;
  const backToLogin = (
    <Link href="/giris" className="font-semibold text-turquoise-700 hover:underline">
      Giriş sayfasına dön
    </Link>
  );

  if (typeof error === "string") {
    return (
      <AuthCard
        title="Doğrulama başarısız"
        description="Yeni bir doğrulama bağlantısı isteyebilirsiniz."
        footer={backToLogin}
      >
        <div className="flex flex-col gap-5">
          <Alert tone="error">{authErrorMessage({ code: error })}</Alert>
          <DevEmailNotice delivery={status.emailDelivery} />
          <ResendVerification variant="form" />
        </div>
      </AuthCard>
    );
  }

  if (durum === "tamam") {
    return (
      <AuthCard title="E-posta adresiniz doğrulandı">
        <div className="flex flex-col gap-5">
          <Alert tone="success">Hesabınız etkinleştirildi. Artık giriş yapabilirsiniz.</Alert>
          <Link href="/giris" className={buttonVariants({ className: "w-full" })}>
            Giriş yap
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Doğrulama e-postası"
      description="Doğrulama bağlantısı ulaşmadıysa veya süresi dolduysa yenisini isteyin."
      footer={backToLogin}
    >
      <div className="flex flex-col gap-5">
        <DevEmailNotice delivery={status.emailDelivery} />
        <ResendVerification variant="form" />
      </div>
    </AuthCard>
  );
}
