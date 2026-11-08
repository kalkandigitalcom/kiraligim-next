/**
 * Süreç içi basit hız sınırı (sabit pencere). YALNIZ ek bir katmandır: birden çok sunucu
 * örneğinde örnekler arası paylaşılmaz ve yeniden başlatmada sıfırlanır. Asıl sınır veritabanında
 * (villa başına, drizzle/0027) uygulanır. Anahtar ham IP değil, çağıranın verdiği özettir.
 */
export function createMemoryRateLimit(opts: { limit: number; windowMs: number; maxKeys?: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const maxKeys = opts.maxKeys ?? 10_000;
  return {
    /** true: izin verildi (sayaç artırıldı); false: sınır aşıldı. */
    take(key: string, now: number = Date.now()): boolean {
      const cur = hits.get(key);
      if (!cur || cur.resetAt <= now) {
        if (hits.size >= maxKeys) {
          for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
          if (hits.size >= maxKeys) hits.delete(hits.keys().next().value as string);
        }
        hits.set(key, { count: 1, resetAt: now + opts.windowMs });
        return true;
      }
      if (cur.count >= opts.limit) return false;
      cur.count += 1;
      return true;
    },
  };
}
