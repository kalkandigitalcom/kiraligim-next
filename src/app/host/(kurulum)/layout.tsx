import { Logo } from "@/components/brand/logo";
import { requireUser } from "@/server/auth/session";

import { SignOutButton } from "../_components/sign-out-button";

/**
 * Kurulum adımları (işletme oluşturma ve işletme seçimi). Henüz seçili bir işletme olmadığından
 * panel kenar çubuğu gösterilmez: yalnız logo, kullanıcı adı ve çıkış. Oturum yoksa /giris'e
 * yönlendirilir; sayfalar ayrıca requireUser() çağırır. Adresler değişmedi (/isletme-olustur,
 * /isletmeler).
 */
export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div className="flex min-h-dvh flex-1 flex-col bg-mist">
      <header className="border-b border-border bg-white">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
          <Logo className="h-7 w-auto" />
          <div className="flex min-w-0 items-center gap-3">
            <span className="hidden truncate text-sm text-muted-foreground sm:inline">
              {user.name}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main id="icerik" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {children}
      </main>
    </div>
  );
}
