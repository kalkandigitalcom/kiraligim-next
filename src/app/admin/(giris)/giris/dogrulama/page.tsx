import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { adminCookieNames, getAdminContext } from "@/server/admin/session";

import { AdminVerifyForm } from "../forms";

export const metadata: Metadata = { title: "İki adımlı doğrulama" };

export default async function AdminVerifyPage() {
  const ctx = getAdminContext();
  if (!ctx) redirect("/giris");
  const jar = await cookies();
  if (!jar.get(adminCookieNames(ctx.config.secureCookies).step)) redirect("/giris");
  return (
    <>
      <h1 className="text-xl font-bold text-navy-900">İki adımlı doğrulama</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Kimlik doğrulama uygulamanızdaki kodu girin. Kod 30 saniyede bir yenilenir.
      </p>
      <AdminVerifyForm />
      <p className="mt-6 text-center text-sm">
        <Link href="/giris" className="text-turquoise-700 hover:underline">
          Başka hesapla giriş yap
        </Link>
      </p>
    </>
  );
}
