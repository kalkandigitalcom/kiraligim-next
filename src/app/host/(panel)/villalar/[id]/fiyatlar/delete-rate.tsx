"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";

import type { DeleteRateState } from "./actions";

/**
 * Silme: önce satır içi onay (tarayıcı diyaloğu yok), sonra server action. Yetki ve kayıt
 * sahipliği sunucuda ve veritabanında denetlenir.
 */
export function DeleteRate({
  action,
  label,
}: {
  action: () => Promise<DeleteRateState>;
  /** Ekran okuyucu için dönemin adı (ör. "1–16 Temmuz 2026"). */
  label: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<DeleteRateState>(action, {});

  if (!confirming) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setConfirming(true)}
        aria-label={`Sil: ${label}`}
      >
        Sil
      </Button>
    );
  }
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2" role="group">
      <span className="text-sm font-medium text-navy-900">Silinsin mi?</span>
      <Button type="submit" size="sm" disabled={pending} aria-label={`Evet, sil: ${label}`}>
        {pending ? "Siliniyor…" : "Evet, sil"}
      </Button>
      <Button type="button" variant="secondary" size="sm" onClick={() => setConfirming(false)}>
        Vazgeç
      </Button>
      {state.error ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
