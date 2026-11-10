import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { adminConfigProblem, getCurrentAdmin } from "@/server/admin/session";

import { AdminLoginForm } from "./forms";

export const metadata: Metadata = { title: "Yönetici girişi" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const NOTICES: Record<string, string> = {
  kilitli: "Çok fazla hatalı deneme. 15 dakika sonra yeniden deneyin.",
  "sure-doldu": "Giriş adımının süresi doldu. Yeniden giriş yapın.",
  cikis: "Çıkış yaptınız.",
};

export default async function AdminLoginPage({ searchParams }: Props) {
  if (adminConfigProblem()) {
    return (
      <Alert tone="info" title="Yönetim paneli yapılandırılmamış">
        Bu ortamda yönetici girişi kapalı. Kurulum adımları docs/deployment.md içindeki “Super
        Admin” bölümündedir.
      </Alert>
    );
  }
  if (await getCurrentAdmin()) redirect("/");
  const { durum } = await searchParams;
  const notice = typeof durum === "string" ? NOTICES[durum] : undefined;
  return (
    <>
      <h1 className="text-xl font-bold text-navy-900">Yönetici girişi</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Yalnız Kiralığım platform yöneticileri içindir. İki adımlı doğrulama zorunludur.
      </p>
      {notice ? (
        <Alert tone={durum === "cikis" ? "success" : "error"} className="mb-5">
          {notice}
        </Alert>
      ) : null}
      <AdminLoginForm />
    </>
  );
}
