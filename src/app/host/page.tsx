import { redirect } from "next/navigation";

import { getSessionUser } from "@/server/auth/session";
import { resolveActiveWorkspace } from "@/server/workspaces/active";

/**
 * app.<alan-adı>/ — yalnız yönlendirir:
 *   oturum yok → /giris; işletme yok → /isletme-olustur; birden çok ve seçim yok veya yalnız
 *   askıdaki işletme → /isletmeler; aksi halde → /panel.
 */
export default async function HostIndexPage() {
  const user = await getSessionUser();
  if (!user) redirect("/giris");
  const active = await resolveActiveWorkspace(user.id);
  if (active.kind === "none") redirect("/isletme-olustur");
  if (active.kind === "choose" || active.kind === "suspended") redirect("/isletmeler");
  redirect("/panel");
}
