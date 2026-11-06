/**
 * Sunucu açılışında bir kez çalışır. DB rol denetimi beklenmeden başlatılır
 * (veritabanı yavaşsa sunucunun açılışını geciktirmesin); sonuç log'a yazılır.
 */
export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  void import("@/lib/db-role-guard")
    .then(({ checkDbRole }) => checkDbRole())
    .catch(() => undefined);
}
