"use client";

import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextareaField } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";
import { RESERVATION_LIMITS as L, type ReservationKind } from "@/lib/reservation-meta";

import type { StatusActionState } from "../actions";

type Action = (state: StatusActionState, data: FormData) => Promise<StatusActionState>;

/** Beklemedeki rezervasyonu onayla. */
export function ConfirmButton({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, {});
  const hydrated = useHydrated();
  return (
    <form action={formAction} className="flex flex-col gap-3">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <Button type="submit" className="w-full sm:w-auto" disabled={pending || !hydrated}>
        {pending ? "Onaylanıyor…" : "Rezervasyonu onayla"}
      </Button>
    </form>
  );
}

/**
 * İki adımlı iptal: önce "İptal et", ardından isteğe bağlı neden + onay. İptal kesindir: kayıt
 * bir daha değiştirilemez ve etkinleştirilemez; tarihler yeniden müsait olur.
 */
export function CancelPanel({ action, kind }: { action: Action; kind: ReservationKind }) {
  const [state, formAction, pending] = useActionState(action, {});
  const [open, setOpen] = useState(false);
  const hydrated = useHydrated();
  const isBlock = kind === "block";
  if (!open) {
    return (
      <Button
        variant="secondary"
        className="w-full text-destructive sm:w-auto"
        disabled={!hydrated}
        onClick={() => setOpen(true)}
      >
        {isBlock ? "Bloğu kaldır" : "Rezervasyonu iptal et"}
      </Button>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <Alert tone="info">
        {isBlock
          ? "Blok kaldırılınca bu tarihler yeniden müsait olur. Bu işlem geri alınamaz."
          : "İptal edilen rezervasyon bir daha düzenlenemez veya etkinleştirilemez; tarihler yeniden müsait olur."}
      </Alert>
      {isBlock ? null : (
        <TextareaField
          id="cancelReason"
          name="cancelReason"
          label="İptal nedeni (isteğe bağlı)"
          maxLength={L.cancelReasonMax}
          className="min-h-20"
        />
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          type="submit"
          className="w-full bg-destructive hover:bg-destructive/90 sm:w-auto"
          disabled={pending}
        >
          {pending ? "İşleniyor…" : isBlock ? "Bloğu kaldırmayı onayla" : "İptali onayla"}
        </Button>
        <Button
          variant="ghost"
          className="w-full sm:w-auto"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Vazgeç
        </Button>
      </div>
    </form>
  );
}
