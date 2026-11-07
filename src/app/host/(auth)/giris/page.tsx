import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { getSessionUser } from "@/server/auth/session";
import { getAuthStatus } from "@/server/auth/status";

import { AuthCard, AuthUnavailable } from "../_components/auth-card";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Giriş yap" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function LoginPage({ searchParams }: Props) {
  const status = getAuthStatus();
  if (!status.available) return <AuthUnavailable />;
  if (await getSessionUser()) redirect("/");
  const { sifre } = await searchParams;

  return (
    <AuthCard
      title="Giriş yap"
      description="İşletme panelinize erişmek için giriş yapın."
      footer={
        status.signupEnabled ? (
          <>
            Hesabınız yok mu?{" "}
            <Link href="/kayit" className="font-semibold text-turquoise-700 hover:underline">
              Kayıt olun
            </Link>
          </>
        ) : null
      }
    >
      {sifre === "yenilendi" ? (
        <Alert tone="success" className="mb-5">
          Şifreniz güncellendi. Yeni şifrenizle giriş yapabilirsiniz.
        </Alert>
      ) : null}
      <LoginForm />
    </AuthCard>
  );
}
