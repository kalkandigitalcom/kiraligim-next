"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * İstemci tarafı JavaScript etkin mi? Sunucu render'ında ve hydration öncesinde false.
 * İstemci tarafında işlenen formların gönder düğmesi bu false iken devre dışı tutulur:
 * aksi halde erken tıklama, tarayıcının varsayılan form gönderimini tetikler.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
