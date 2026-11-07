import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { getSessionUser } from "@/server/auth/session";
import { getAuthStatus } from "@/server/auth/status";

import { AuthCard, AuthUnavailable, DevEmailNotice } from "../_components/auth-card";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Hesap oluştur" };

const loginLink = (
  <>
    Zaten hesabınız var mı?{" "}
    <Link href="/giris" className="font-semibold text-turquoise-700 hover:underline">
      Giriş yapın
    </Link>
  </>
);

export default async function SignupPage() {
  const status = getAuthStatus();
  if (!status.available) return <AuthUnavailable />;
  if (await getSessionUser()) redirect("/");

  // AUTH_SIGNUP_ENABLED=false iken form hiç gösterilmez; Better Auth uç noktası da kapalıdır.
  if (!status.signupEnabled) {
    return (
      <AuthCard title="Kayıtlar şu an kapalı" footer={loginLink}>
        <Alert tone="info">
          Yeni hesap kaydı şu an alınmıyor. Hesabınız varsa giriş yapabilirsiniz.
        </Alert>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Hesap oluşturun"
      description="Birkaç adımda işletmenizi oluşturup panele geçin."
      footer={loginLink}
    >
      <SignupForm devNotice={<DevEmailNotice delivery={status.emailDelivery} />} />
    </AuthCard>
  );
}
