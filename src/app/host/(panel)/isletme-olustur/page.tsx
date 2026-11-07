import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireUser } from "@/server/auth/session";
import { countMyMemberships } from "@/server/workspaces/active";

import { CreateWorkspaceForm } from "./create-workspace-form";

export const metadata: Metadata = { title: "İşletmenizi oluşturun" };

/**
 * İlk işletme sihirbazı: yalnız HİÇ üyeliği olmayan (askıdaki dahil), oturum açmış kullanıcı için.
 * Askıdaki işletmenin sahibi yeni işletme açarak askıyı dolanamaz.
 */
export default async function CreateWorkspacePage() {
  const user = await requireUser();
  if ((await countMyMemberships(user.id)) > 0) redirect("/");

  return (
    <div className="mx-auto w-full max-w-xl">
      <p className="text-sm font-medium text-turquoise-700">Son adım</p>
      <h1 className="mt-1 text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">
        İşletmenizi oluşturun
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
        Villalarınızı, rezervasyonlarınızı ve ekibinizi bu işletme altında yöneteceksiniz.
      </p>
      <div className="mt-8 rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8">
        <CreateWorkspaceForm />
      </div>
    </div>
  );
}
