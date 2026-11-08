"use client";

import { LogOut } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

/**
 * Oturumu Better Auth üzerinden kapatır (sunucuda oturum kaydı silinir, çerez temizlenir).
 * `appearance="sidebar"`: panel kenar çubuğunun alt bölümündeki tam genişlik satır.
 */
export function SignOutButton({ appearance = "button" }: { appearance?: "button" | "sidebar" }) {
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setPending(true);
    setFailed(false);
    const { error } = await authClient.signOut();
    if (error) {
      setFailed(true);
      setPending(false);
      return;
    }
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- oturum değişti: istemci önbelleği tamamen atılsın, sunucu yeni çerezle render etsin.
    window.location.assign("/giris");
  }

  const label = pending ? "Çıkış yapılıyor…" : "Çıkış yap";
  const error = failed ? (
    <span role="alert" className="text-sm text-destructive">
      Çıkış yapılamadı.
    </span>
  ) : null;

  if (appearance === "sidebar") {
    return (
      <div className="flex flex-col gap-1">
        {error}
        <button
          type="button"
          disabled={!hydrated || pending}
          onClick={signOut}
          className={cn(
            "flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors",
            "hover:bg-mist hover:text-navy-900 focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none disabled:opacity-60",
          )}
        >
          <LogOut className="size-[18px] shrink-0" aria-hidden="true" />
          {label}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {error}
      <Button variant="secondary" size="sm" disabled={!hydrated || pending} onClick={signOut}>
        {label}
      </Button>
    </div>
  );
}
