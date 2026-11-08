import { getDb } from "@/db/client";
import { requireUser } from "@/server/auth/session";
import { resolveActiveWorkspace } from "@/server/workspaces/active";
import { listMyWorkspaces } from "@/server/workspaces/service";

import { PanelShell, type ShellWorkspace } from "./_components/panel-shell";

const ROLE_LABEL = { owner: "Sahip", manager: "Yönetici", staff: "Personel" } as const;

/**
 * Korumalı panel bölümü: sol kenar çubuğu (mobilde çekmece) + içerik. Oturum yoksa her istekte
 * /giris'e yönlendirilir; sayfalar ayrıca requireUser()/withPanelTenant çağırır (layout'lar her
 * gezinmede yeniden çalışmayabilir). Kenar çubuğundaki işletme adı ve rol yalnız bilgi amaçlıdır;
 * yetki kararları sayfa ve action'larda withTenant ile verilir.
 */
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const active = await resolveActiveWorkspace(user.id);
  let workspace: ShellWorkspace = null;
  if (active.kind === "selected") {
    const all = await listMyWorkspaces(getDb(), user.id);
    workspace = {
      name: active.workspace.name,
      roleLabel: ROLE_LABEL[active.workspace.role],
      canSwitch: all.length > 1,
    };
  }
  return (
    <PanelShell user={{ name: user.name, email: user.email }} workspace={workspace}>
      {children}
    </PanelShell>
  );
}
