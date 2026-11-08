/**
 * Tarayıcı Geri / İleri (popstate) kapısı. Kaydedilmemiş değişiklik uyarısının, Next.js
 * yönlendiricisinden ÖNCE devreye girebilmesi için tek bir popstate dinleyicisi uygulama
 * başlarken (src/instrumentation-client.ts, hydration öncesi) kaydedilir.
 *
 * Neden: `window` üzerindeki popstate dinleyicileri kayıt sırasıyla çalışır (yakalama aşaması bunu
 * değiştirmez); Next.js'in dinleyicisi uygulama açılırken kaydedildiğinden, sayfa bileşeninin
 * sonradan eklediği dinleyici ondan sonra çalışır ve sayfa çoktan yeniden çizilmiş olur.
 *
 * Kapı yalnız bir koruma (ör. sihirbaz formu) etkinken bir şey yapar; aksi halde olaya dokunmaz.
 */

type Guard = (event: PopStateEvent) => void;

let guard: Guard | null = null;
let installed = false;

/** Kapıyı kurar (bir kez). Uygulama başlangıcında çağrılır. */
export function installHistoryGate(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("popstate", (event) => guard?.(event), true);
}

/**
 * Etkin korumayı ayarlar; kaldırma fonksiyonu döner. Koruma olayı yönlendiriciden saklamak için
 * `event.stopImmediatePropagation()` çağırır.
 */
export function setHistoryGuard(fn: Guard): () => void {
  // Başlangıçta kurulmadıysa (beklenmez) yine de kur; bu durumda sıra garanti değildir.
  installHistoryGate();
  guard = fn;
  return () => {
    if (guard === fn) guard = null;
  };
}
