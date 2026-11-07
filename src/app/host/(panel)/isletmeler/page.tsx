import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { getDb } from "@/db/client";
import { requireUser } from "@/server/auth/session";
import { countMyMemberships } from "@/server/workspaces/active";
import { listMyWorkspaces } from "@/server/workspaces/service";

import { selectWorkspaceAction } from "./actions";

export const metadata: Metadata = { title: "İşletme seçin" };

const ROLE_LABEL = { owner: "Sahip", manager: "Yönetici", staff: "Personel" } as const;

/** Birden çok işletmeye üye kullanıcı için seçim ekranı; aktif işletme yoksa askı bilgisi. */
export default async function SelectWorkspacePage() {
  const user = await requireUser();
  const workspaces = await listMyWorkspaces(getDb(), user.id);
  if (workspaces.length === 0) {
    if ((await countMyMemberships(user.id)) === 0) redirect("/isletme-olustur");
    return (
      <div className="mx-auto w-full max-w-xl">
        <h1 className="text-2xl font-bold tracking-tight text-navy-900">
          İşletmenize şu an erişilemiyor
        </h1>
        <Alert tone="info" className="mt-6">
          Üyesi olduğunuz işletme geçici olarak erişime kapatılmış (askıya alınmış). Ayrıntı için
          destek ekibiyle iletişime geçin.
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-xl">
      <h1 className="text-2xl font-bold tracking-tight text-navy-900">İşletme seçin</h1>
      <p className="mt-2 text-[15px] text-muted-foreground">
        Birden fazla işletmeye üyesiniz. Devam etmek istediğinizi seçin.
      </p>
      <ul className="mt-6 flex flex-col gap-3">
        {workspaces.map((w) => (
          <li key={w.id}>
            <form action={selectWorkspaceAction}>
              <input type="hidden" name="workspaceId" value={w.id} />
              <button
                type="submit"
                className="flex w-full items-center justify-between gap-4 rounded-2xl border border-border bg-white px-5 py-4 text-left shadow-sm transition-colors hover:border-turquoise-500 focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none"
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-navy-900">{w.name}</span>
                  <span className="block truncate text-sm text-muted-foreground">{w.slug}</span>
                </span>
                <span className="shrink-0 text-sm text-muted-foreground">{ROLE_LABEL[w.role]}</span>
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
