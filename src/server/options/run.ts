/**
 * Opsiyon Aşama 3b — option-maintenance görevinin bir çalıştırması (saf orkestrasyon).
 *
 * Mevcut WhatsApp worker'ından TAMAMEN ayrıdır (K-C, K-D): worker.ts / cron.ts'e bağlanmaz, onları
 * içe aktarmaz; ayrı süreç ve ayrı bağlantıyla çalışır. Bütün veri işi 0069'daki SECURITY DEFINER
 * fonksiyonlarıyla yapılır (her çağrı tek ve kısa transaction):
 *
 *   1. Süre dolumu   — app_option_expire_due: süresi dolan AÇIK opsiyon → expired. Kill switch'ten
 *                      bağımsızdır (opsiyon müsaitliği zaten etkilemez); FOR UPDATE SKIP LOCKED.
 *   2. Çakışma uyarısı — app_option_scan_conflicts: açık opsiyonla çakışan beklemede / onaylı kayıt
 *                      veya blok ve etkin harici olay için Super Admin uyarısı. Opsiyon ve
 *                      rezervasyon DEĞİŞMEZ; (opsiyon, kaynak) başına tek uyarı.
 *   3. Mesaj imleci  — app_option_claim_messages: YALNIZ bir mesaj işleyicisi verilmişse (Aşama 3d).
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

type Executor = Pick<Database, "execute">;

/** Aynı anda tek option-maintenance süreci (oturum advisory lock'u). */
export const OPTION_MAINTENANCE_LOCK = "kiraligim:option-maintenance";

export const OPTION_MAINTENANCE_LIMITS = {
  expireBatch: 100,
  alertBatch: 500,
  messageBatch: 20,
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
  maxRounds?: number;
  budgetMs?: number;
  /** Verilmezse mesaj adımı kapalıdır (Aşama 3b üretim davranışı). */
  handleMessage?: OptionMessageHandler;
};

export type OptionMaintenanceStep = "expire" | "alerts" | "messages";

export type OptionMaintenanceSummary =
  | { locked: false }
  | {
      locked: true;
      expired: number;
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
  const maxRounds = clamp(deps.maxRounds, L.maxRounds, 100);
  const deadline = now() + (deps.budgetMs ?? L.budgetMs);

  const got = await db.execute<{ ok: boolean }>(
    sql`select pg_try_advisory_lock(hashtextextended(${OPTION_MAINTENANCE_LOCK}, 0)) as ok`,
  );
  if (!got.rows[0]?.ok) return { locked: false };

  const failedSteps: OptionMaintenanceStep[] = [];
  let expired = 0;
  let alerts = 0;
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

    // 2. Çakışma uyarısı (yalnız uyarı; opsiyon ve rezervasyon değişmez).
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

    // 3. Mesaj imleci: yalnız işleyici verilmişse (Aşama 3d). 3b üretiminde kapalı.
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
  return { locked: true, expired, alerts, messages, failedSteps };
}
