"use client";

import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import type { PublishState } from "./actions";

/**
 * Yayınla / yayından kaldır. Kaldırma satır içi onayla yapılır (tarayıcı diyaloğu yok). Koşullar ve
 * yetki sunucuda ve veritabanında yeniden denetlenir; düğmenin kapalı olması yalnız kolaylıktır.
 */
export function PublishControls({
  isPublic,
  canPublish,
  publish,
  unpublish,
}: {
  isPublic: boolean;
  canPublish: boolean;
  publish: () => Promise<PublishState>;
  unpublish: () => Promise<PublishState>;
}) {
  const [pubState, pubAction, pubPending] = useActionState<PublishState>(publish, {});
  const [unpubState, unpubAction, unpubPending] = useActionState<PublishState>(unpublish, {});
  const [confirming, setConfirming] = useState(false);
  const error = pubState.error ?? unpubState.error;

  return (
    <div className="flex flex-col gap-3">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {!isPublic ? (
        <form action={pubAction}>
          <Button type="submit" disabled={!canPublish || pubPending}>
            {pubPending ? "Yayınlanıyor…" : "Sayfayı yayınla"}
          </Button>
        </form>
      ) : !confirming ? (
        <div>
          <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
            Yayından kaldır
          </Button>
        </div>
      ) : (
        <form
          action={unpubAction}
          className="flex flex-col gap-3 rounded-xl border border-border bg-mist p-4"
          role="group"
        >
          <p className="text-sm text-navy-900">
            Sayfa yayından kaldırılırsa paylaştığınız bağlantı müşteriler için açılmaz. Ayarlarınız
            korunur; istediğiniz zaman yeniden yayınlayabilirsiniz.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={unpubPending}>
              {unpubPending ? "Kaldırılıyor…" : "Evet, yayından kaldır"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
              Vazgeç
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
