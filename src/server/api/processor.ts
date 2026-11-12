/**
 * Acente API'si 2. aşama — takvim değişikliği işlemcisi (4. adım).
 *
 * İşin kendisi veritabanındadır (app_api_process_changes, drizzle/0059): "değişti" satırlarını
 * villa başına birleştirir, güncel doluluğu merkezi hesaplamayla yazar, last_change_id'yi aynı
 * transaction'da günceller; villa hatası yalnız o villayı geri alır ve yeniden deneme bilgisi yazar.
 *
 * Bu modül süreci yönetir:
 *  - `db` TEK bağlantılı bir havuzdur (createStandaloneDb(url, { max: 1, idleTimeoutMillis: 0 })):
 *    oturum kilidi o bağlantıya aittir.
 *  - Oturum düzeyi advisory lock (pg_try_advisory_lock): aynı anda tek işlemci süreci. Kilidi
 *    alamayan süreç hemen çıkar. Süreç düşerse bağlantı kapanır, kilit PostgreSQL tarafından
 *    bırakılır; normal bitişte finally içinde açıkça bırakılır.
 *  - En fazla maxMs (varsayılan 50 sn) çalışır; her turda bekleyen işi bitene kadar işler, sonra
 *    intervalMs (varsayılan 3 sn) bekleyip yeniden bakar. Coolify Scheduled Task dakikada bir
 *    başlatır; süreler üst üste binmez.
 *  - Çalıştırma başında bir kez 30 günlük saklama temizliği (app_api_prune_changes).
 *  - 5. adım: `deliver` verilirse her turda işlemeden sonra süresi gelmiş webhook teslimleri
 *    gönderilir (webhooks.ts deliverDue); başta bir kez 31 günden eski teslim kayıtları temizlenir.
 * Log'a yalnız sayılar yazılır (villa, tarih, kimlik yazılmaz).
 */
import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";

export const API_SYNC_LOCK = "kiraligim:api-sync";

export type ProcessResult = {
  processed: number;
  failed: number;
  changes: number;
  discarded: number;
  lastChangeId: number;
};

/** Tek veritabanı çağrısı (tek transaction): en fazla `batch` villa. */
export async function processChangesOnce(db: Database, batch = 50): Promise<ProcessResult> {
  const r = await db.execute<{
    processed: number;
    failed: number;
    changes: number;
    discarded: number;
    last_change_id: string;
  }>(sql`select * from public.app_api_process_changes(${batch}::integer)`);
  const row = r.rows[0]!;
  return {
    processed: Number(row.processed),
    failed: Number(row.failed),
    changes: Number(row.changes),
    discarded: Number(row.discarded),
    lastChangeId: Number(row.last_change_id),
  };
}

export type SyncLoopOptions = {
  maxMs?: number;
  intervalMs?: number;
  batch?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Webhook gönderimi (5. adım); kalan süre (ms) verilir. */
  deliver?: (budgetMs: number) => Promise<DeliverCounts>;
  /** Teslim kayıtları saklama temizliği (5. adım). */
  pruneDeliveries?: () => Promise<number>;
};

export type DeliverCounts = {
  attempted: number;
  delivered: number;
  retried: number;
  failed: number;
  stale: number;
};

export type SyncSummary =
  | { locked: false }
  | {
      locked: true;
      rounds: number;
      processed: number;
      failed: number;
      changes: number;
      discarded: number;
      pruned: number;
      lastChangeId: number;
      webhooks?: DeliverCounts;
    };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * İşlemci döngüsü. `db` tek bağlantılı havuzdur: advisory lock bu oturuma aittir.
 */
export async function runApiSync(db: Database, opts: SyncLoopOptions = {}): Promise<SyncSummary> {
  const maxMs = opts.maxMs ?? 50_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const batch = opts.batch ?? 50;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  const got = await db.execute<{ ok: boolean }>(
    sql`select pg_try_advisory_lock(hashtextextended(${API_SYNC_LOCK}, 0)) as ok`,
  );
  if (!got.rows[0]?.ok) return { locked: false };

  const started = now();
  const total = {
    rounds: 0,
    processed: 0,
    failed: 0,
    changes: 0,
    discarded: 0,
    pruned: 0,
    lastChangeId: 0,
  };
  const webhooks: DeliverCounts = { attempted: 0, delivered: 0, retried: 0, failed: 0, stale: 0 };
  try {
    const pruned = await db.execute<{ n: number }>(sql`select public.app_api_prune_changes() as n`);
    total.pruned = Number(pruned.rows[0]?.n ?? 0);
    if (opts.pruneDeliveries) total.pruned += await opts.pruneDeliveries();
    for (;;) {
      total.rounds += 1;
      // Bekleyen iş bitene kadar (her çağrı ayrı, kısa transaction: snapshot'ları uzun bekletmez).
      for (;;) {
        const r = await processChangesOnce(db, batch);
        total.processed += r.processed;
        total.failed += r.failed;
        total.changes += r.changes;
        total.discarded += r.discarded;
        total.lastChangeId = r.lastChangeId;
        if (r.processed + r.failed + r.discarded < batch) break;
        if (now() - started >= maxMs) break;
      }
      if (opts.deliver) {
        const budget = maxMs - (now() - started);
        if (budget > 0) {
          const d = await opts.deliver(budget);
          for (const k of Object.keys(webhooks) as (keyof DeliverCounts)[]) webhooks[k] += d[k];
        }
      }
      if (now() - started + intervalMs >= maxMs) break;
      await sleep(intervalMs);
    }
  } finally {
    await db
      .execute(sql`select pg_advisory_unlock(hashtextextended(${API_SYNC_LOCK}, 0))`)
      .catch(() => undefined);
  }
  return opts.deliver ? { locked: true, ...total, webhooks } : { locked: true, ...total };
}
