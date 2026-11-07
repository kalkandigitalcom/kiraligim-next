"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import { authClient } from "@/lib/auth-client";

/** Oturumu Better Auth üzerinden kapatır (sunucuda oturum kaydı silinir, çerez temizlenir). */
export function SignOutButton() {
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex items-center gap-2">
      {failed ? (
        <span role="alert" className="text-sm text-destructive">
          Çıkış yapılamadı.
        </span>
      ) : null}
      <Button
        variant="secondary"
        size="sm"
        disabled={!hydrated || pending}
        onClick={async () => {
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
        }}
      >
        {pending ? "Çıkış yapılıyor…" : "Çıkış yap"}
      </Button>
    </div>
  );
}
