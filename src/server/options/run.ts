/**
 * Opsiyon Aşama 3b — option-maintenance görevinin bir çalıştırması (saf orkestrasyon).
 *
 * Mevcut WhatsApp worker'ından TAMAMEN ayrıdır (K-C, K-D): worker.ts / cron.ts'e bağlanmaz, onları
 * içe aktarmaz; ayrı süreç ve ayrı bağlantıyla çalışır. Bütün veri işi 0069'daki SECURITY DEFINER
 * fonksiyonlarıyla yapılır (her çağrı tek ve kısa transaction):
 *
 *   1. Süre dolumu   — app_option_expire_due: süresi dolan AÇIK opsiyon → expired. Kill switch'ten
 *                      bağımsızdır (opsiyon müsaitliği zaten etkilemez); FOR UPDATE SKIP LOCKED.
 *   2. Onaylı işlem  — Aşama 3c: Super Admin'in onayladığı OLUŞTUR / İPTAL işlemleri
 *                      (app_option_claim_approved_operations + app_option_apply_approved_operation,
 *                      drizzle/0071). Global + işletme + grup anahtarı açık değilse hiçbiri alınmaz;
 *                      uygulama anında anahtar satırları kilitlenip anahtarlar, grubun villası,
 *                      takvim parmak izi ve hedef sürümü YENİDEN doğrulanır (tek transaction).
 *                      Kesinleştirme 3e'ye kadar alınmaz.
 *   2b. Kesinleştirme — Aşama 3e: Super Admin onaylı kesinleştirme (./convert, drizzle/0073):
 *                      işletme sahibi adına TEK transaction'da kesin rezervasyon; anahtarlar,
 *                      takvim, opsiyon sürümü, villa ve misafir bilgisi yeniden doğrulanır.
 *   3. Çakışma uyarısı — app_option_scan_conflicts: açık opsiyonla çakışan beklemede / onaylı kayıt
 *                      veya blok ve etkin harici olay için Super Admin uyarısı. Opsiyon ve
 *                      rezervasyon DEĞİŞMEZ; (opsiyon, kaynak) başına tek uyarı.
 *   4. Mesaj imleci  — app_option_claim_messages: YALNIZ bir mesaj işleyicisi verilmişse (Aşama 3d).
 *                      İşleyici yoksa imleç HİÇ okunmaz: hiçbir mesaj "işlendi" sayılmaz, 3d
 *                      geldiğinde kayıp olmaz. Otomasyon (global + işletme + grup) kapalıysa
 *                      fonksiyon zaten hiçbir mesaj döndürmez. İşleyici hata verirse imleç "claimed"
 *                      kalır; 5 dakika sonra en fazla 3 kez yeniden alınır.
 *
 * Tekrar çalışma güvenliği: oturum düzeyinde advisory lock (aynı anda tek görev); kilidi alamayan
 * çalıştırma hiçbir şey yapmadan çıkar. Her adım idempotenttir (ikinci çalıştırma aynı kaydı
 * yeniden yazmaz). Bir adımın hatası diğerlerini durdurmaz; yalnız bu görevin sonucunu etkiler.
 * Log'a mesaj içeriği, misafir veya telefon bilgisi YAZILMAZ; yalnız sayılar ve kısa hata kodları.
 */
import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import type { Logger } from "@/lib/logger";

import type { ConvertOutcome, OptionConverter } from "./convert";

type Executor = Pick<Database, "execute">;

/** Bir turda alınan en fazla kesinleştirme (her biri ayrı transaction'da rezervasyon oluşturur). */
const CONVERSION_BATCH = 10;

/** Aynı anda tek option-maintenance süreci (oturum advisory lock'u). */
export const OPTION_MAINTENANCE_LOCK = "kiraligim:option-maintenance";

export const OPTION_MAINTENANCE_LIMITS = {
  expireBatch: 100,
  alertBatch: 500,
  messageBatch: 20,
  operationBatch: 20,
  /** Bir adımın en fazla tur sayısı (sonsuz döngüye karşı). */
  maxRounds: 20,
  /** Tüm çalıştırmanın süre bütçesi (ms); Coolify görevi her dakika. */
  budgetMs: 40_000,
} as const;

/** app_option_claim_messages satırı. `body` YALNIZ işleyiciye verilir; loglanmaz. */
export type ClaimedOptionMessage = {
  messageId: string;
  workspaceId: string;
  groupId: string;
  propertyId: string | null;
  waMessageId: string;
  body: string;
  sentAt: Date;
  attempts: number;
};

/**
 * Aşama 3d'de bağlanacak mesaj işleyicisi. Başarıyla biten işleyici mesajın imlecini
 * kapatmalıdır (app_wa_option_apply imleci "done" yapar). Fırlatırsa imleç "claimed" kalır.
 */
export type OptionMessageHandler = (db: Executor, m: ClaimedOptionMessage) => Promise<void>;

export type OptionMaintenanceDeps = {
  log?: Logger;
  now?: () => number;
  expireBatch?: number;
  alertBatch?: number;
  messageBatch?: number;
  operationBatch?: number;
  maxRounds?: number;
  budgetMs?: number;
  /** Verilmezse mesaj adımı kapalıdır (Aşama 3b üretim davranışı). */
  handleMessage?: OptionMessageHandler;
  /**
   * Aşama 3e: Super Admin onaylı kesinleştirmeyi uygular (./convert). Verilmezse kesinleştirme
   * adımı kapalıdır (onaylı kesinleştirme alınmaz, bekler).
   */
  convert?: OptionConverter;
};

export type OptionMaintenanceStep = "expire" | "operations" | "conversions" | "alerts" | "messages";

/** Kesinleştirme adımının sonuçları (ConvertOutcome başına sayı). */
export type OptionConversionCounts = { claimed: number } & Record<ConvertOutcome, number>;

/** Onaylı işlem adımının sonuçları (app_option_apply_approved_operation dönüşleri). */
export type OptionOperationCounts = {
  claimed: number;
  applied: number;
  stale: number;
  failed: number;
  automationOff: number;
  lost: number;
  errors: number;
};

export type OptionMaintenanceSummary =
  | { locked: false }
  | {
      locked: true;
      expired: number;
      operations: OptionOperationCounts;
      conversions: "disabled" | OptionConversionCounts;
      alerts: number;
      messages: "disabled" | { claimed: number; handled: number; failed: number };
      failedSteps: OptionMaintenanceStep[];
    };

/** Hata nesnesinden yalnız güvenli alanlar (sorgu parametreleri ve mesaj içeriği yazılmaz). */
function errorCode(err: unknown): { code: string } {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : null;
  const msg = typeof e?.message === "string" && /^[a-z_]{1,60}$/.test(e.message) ? e.message : null;
  return { code: msg ?? code ?? (err instanceof Error ? err.name : "error") };
}

const clamp = (v: number | undefined, def: number, max: number) =>
  Math.min(Math.max(1, Math.floor(v ?? def)), max);

/**
 * Bir çalıştırma. `db` TEK bağlantılı havuz olmalıdır: advisory lock bu oturuma aittir ve
 * çalıştırma sonunda bırakılır (süreç düşerse bağlantıyla birlikte kendiliğinden bırakılır).
 */
export async function runOptionMaintenance(
  db: Executor,
  deps: OptionMaintenanceDeps = {},
): Promise<OptionMaintenanceSummary> {
  const L = OPTION_MAINTENANCE_LIMITS;
  const now = deps.now ?? Date.now;
  const log = deps.log;
  const expireBatch = clamp(deps.expireBatch, L.expireBatch, 200);
  const alertBatch = clamp(deps.alertBatch, L.alertBatch, 500);
  const messageBatch = clamp(deps.messageBatch, L.messageBatch, 50);
  const operationBatch = clamp(deps.operationBatch, L.operationBatch, 20);
  const maxRounds = clamp(deps.maxRounds, L.maxRounds, 100);
  const deadline = now() + (deps.budgetMs ?? L.budgetMs);

  const got = await db.execute<{ ok: boolean }>(
    sql`select pg_try_advisory_lock(hashtextextended(${OPTION_MAINTENANCE_LOCK}, 0)) as ok`,
  );
  if (!got.rows[0]?.ok) return { locked: false };

  const failedSteps: OptionMaintenanceStep[] = [];
  let expired = 0;
  let alerts = 0;
  let conversions: "disabled" | OptionConversionCounts = "disabled";
  const operations: OptionOperationCounts = {
    claimed: 0,
    applied: 0,
    stale: 0,
    failed: 0,
    automationOff: 0,
    lost: 0,
    errors: 0,
  };
  let messages: "disabled" | { claimed: number; handled: number; failed: number } = "disabled";
  try {
    // 1. Süre dolumu (kill switch'ten bağımsız).
    try {
      for (let round = 0; round < maxRounds && now() < deadline; round++) {
        const r = await db.execute<{ n: number }>(
          sql`select public.app_option_expire_due(${expireBatch}) as n`,
        );
        const n = Number(r.rows[0]?.n ?? 0);
        expired += n;
        if (n < expireBatch) break;
      }
    } catch (err) {
      failedSteps.push("expire");
      log?.error("option_maintenance_step_failed", { step: "expire", ...errorCode(err) });
    }

    // 2. Super Admin onaylı oluşturma / iptal (anahtarlar kapalıysa hiçbiri alınmaz).
    try {
      for (let round = 0; round < maxRounds && now() < deadline; round++) {
        const r = await db.execute<{ id: string; lock_token: string }>(
          sql`select id, lock_token from public.app_option_claim_approved_operations(${operationBatch})`,
        );
        if (r.rows.length === 0) break;
        operations.claimed += r.rows.length;
        for (const row of r.rows) {
          try {
            const a = await db.execute<{ out: string }>(
              sql`select public.app_option_apply_approved_operation(${row.id}::uuid, ${row.lock_token}::uuid) as out`,
            );
            const out = a.rows[0]?.out;
            if (out === "applied") operations.applied++;
            else if (out === "stale") operations.stale++;
            else if (out === "failed") operations.failed++;
            else if (out === "automation_off") operations.automationOff++;
            else operations.lost++;
          } catch (err) {
            // Transaction geri alınır; kilit 2 dk sonra düşer, en fazla 5 deneme.
            operations.errors++;
            log?.warn("option_maintenance_operation_failed", {
              operation: row.id,
              ...errorCode(err),
            });
          }
        }
        if (r.rows.length < operationBatch) break;
      }
    } catch (err) {
      failedSteps.push("operations");
      log?.error("option_maintenance_step_failed", { step: "operations", ...errorCode(err) });
    }

    // 2b. Aşama 3e: Super Admin onaylı kesinleştirme (anahtarlar kapalıysa hiçbiri alınmaz).
    if (deps.convert) {
      const c: OptionConversionCounts = {
        claimed: 0,
        applied: 0,
        stale: 0,
        failed: 0,
        automation_off: 0,
        lost: 0,
        retry: 0,
      };
      conversions = c;
      try {
        for (let round = 0; round < maxRounds && now() < deadline; round++) {
          const r = await db.execute<{ id: string; lock_token: string; workspace_id: string }>(
            sql`select id, lock_token, workspace_id from public.app_option_claim_approved_conversions(${CONVERSION_BATCH})`,
          );
          if (r.rows.length === 0) break;
          c.claimed += r.rows.length;
          for (const row of r.rows) {
            try {
              const out = await deps.convert({
                id: row.id,
                lockToken: row.lock_token,
                workspaceId: row.workspace_id,
              });
              c[out]++;
            } catch (err) {
              // Kilit 2 dk sonra düşer, en fazla 5 deneme.
              c.retry++;
              log?.warn("option_maintenance_conversion_failed", {
                operation: row.id,
                ...errorCode(err),
              });
            }
          }
          if (r.rows.length < CONVERSION_BATCH) break;
        }
      } catch (err) {
        failedSteps.push("conversions");
        log?.error("option_maintenance_step_failed", { step: "conversions", ...errorCode(err) });
      }
    }

    // 3. Çakışma uyarısı (yalnız uyarı; opsiyon ve rezervasyon değişmez).
    try {
      for (let round = 0; round < maxRounds && now() < deadline; round++) {
        const r = await db.execute<{ n: number }>(
          sql`select public.app_option_scan_conflicts(${alertBatch}) as n`,
        );
        const n = Number(r.rows[0]?.n ?? 0);
        alerts += n;
        if (n < alertBatch) break;
      }
    } catch (err) {
      failedSteps.push("alerts");
      log?.error("option_maintenance_step_failed", { step: "alerts", ...errorCode(err) });
    }

    // 4. Mesaj imleci: yalnız işleyici verilmişse (Aşama 3d). 3b üretiminde kapalı.
    if (deps.handleMessage) {
      const m = { claimed: 0, handled: 0, failed: 0 };
      messages = m;
      try {
        for (let round = 0; round < maxRounds && now() < deadline; round++) {
          const r = await db.execute<{
            message_id: string;
            workspace_id: string;
            group_id: string;
            property_id: string | null;
            wa_message_id: string;
            body: string;
            sent_at: Date | string;
            attempts: number;
          }>(sql`select * from public.app_option_claim_messages(${messageBatch})`);
          if (r.rows.length === 0) break;
          m.claimed += r.rows.length;
          for (const row of r.rows) {
            try {
              await deps.handleMessage(db, {
                messageId: row.message_id,
                workspaceId: row.workspace_id,
                groupId: row.group_id,
                propertyId: row.property_id,
                waMessageId: row.wa_message_id,
                body: row.body,
                sentAt: new Date(row.sent_at),
                attempts: Number(row.attempts),
              });
              m.handled++;
            } catch (err) {
              // İmleç "claimed" kalır; 5 dk sonra en fazla 3 kez yeniden alınır.
              m.failed++;
              log?.warn("option_maintenance_message_failed", {
                message: row.message_id,
                attempts: Number(row.attempts),
                ...errorCode(err),
              });
            }
          }
          if (r.rows.length < messageBatch) break;
        }
      } catch (err) {
        failedSteps.push("messages");
        log?.error("option_maintenance_step_failed", { step: "messages", ...errorCode(err) });
      }
    }
  } finally {
    await db
      .execute(sql`select pg_advisory_unlock(hashtextextended(${OPTION_MAINTENANCE_LOCK}, 0))`)
      .catch(() => undefined);
  }
  return { locked: true, expired, operations, conversions, alerts, messages, failedSteps };
}
