import { sql } from "drizzle-orm";

import { PG, pgErrorInfo } from "@/db/pg-error";
import type { TenantContext, Tx } from "@/db/tenant";
import { forbidden, validationError } from "@/lib/errors";
import { OPTION_SETTINGS_LIMITS } from "@/lib/option-meta";

/**
 * Opsiyon Faz A (drizzle/0075) — işletme panelinin opsiyon bölümü. withTenant içinden çağrılır;
 * işletme yalnız oturum bağlamından gelir (istemciden kimlik alınmaz).
 *
 *   - Okuma mevcut RLS politikalarıyla: workspace_option_settings ve option_operations yalnız kendi
 *     işletmesinin owner / manager'ına görünür; option_automation_global herkese açıktır.
 *   - Varsayılan süreyi YALNIZ işletme sahibi değiştirir (app_option_owner_set_default; rol ve
 *     işletme veritabanında yeniden denetlenir, işletmenin denetim kaydına yazılır).
 *   - "Açıklama bekleyenler" (mode = clarify) Faz A'da salt okunurdur; mesaj metni ve misafir
 *     bilgisi gösterilmez. Kapatma / düzenleme Faz C'de.
 */

export type OwnerOptionSettings = {
  /** İşletmenin kendi varsayılanı (dakika); null: sistem varsayılanı kullanılır. */
  workspaceMinutes: number | null;
  /** Sistem geneli varsayılan (dakika). */
  systemMinutes: number;
  /** Super Admin'in tanımladığı süre seçenekleri (boşsa serbest süre). */
  choices: number[];
  /** Geçerli varsayılan ve kaynağı. */
  effectiveMinutes: number;
  effectiveSource: "workspace_default" | "system_default";
  canEdit: boolean;
};

export type OwnerClarification = {
  id: string;
  propertyName: string;
  checkIn: string | null;
  checkOut: string | null;
  reasons: string[];
  sentAt: Date | null;
  createdAt: Date;
};

const canSee = (ctx: TenantContext) => ctx.role === "owner" || ctx.role === "manager";

export async function getOwnerOptionSettings(
  tx: Tx,
  ctx: TenantContext,
): Promise<OwnerOptionSettings> {
  if (!canSee(ctx)) throw forbidden("Opsiyon ayarlarını işletme sahibi ve yöneticiler görür.");
  const sys = await tx.execute<{ minutes: number | string }>(sql`
    select default_duration_minutes as minutes from option_automation_global where id = 1`);
  const ws = await tx.execute<{ minutes: number | string | null; choices: number[] | null }>(sql`
    select default_duration_minutes as minutes, duration_choices as choices
      from workspace_option_settings where workspace_id = app_current_workspace_id()`);
  const systemMinutes = Number(sys.rows[0]?.minutes ?? 0);
  const raw = ws.rows[0]?.minutes;
  const workspaceMinutes = raw === null || raw === undefined ? null : Number(raw);
  return {
    workspaceMinutes,
    systemMinutes,
    choices: (ws.rows[0]?.choices ?? []).map(Number),
    effectiveMinutes: workspaceMinutes ?? systemMinutes,
    effectiveSource: workspaceMinutes === null ? "system_default" : "workspace_default",
    canEdit: ctx.role === "owner",
  };
}

/** İşletmenin varsayılan süresi (dakika; null = sistem varsayılanına dön). Döner: değişti mi. */
export async function setOwnerDefaultDuration(
  tx: Tx,
  ctx: TenantContext,
  minutes: number | null,
): Promise<{ changed: boolean }> {
  if (ctx.role !== "owner") {
    throw forbidden("Varsayılan opsiyon süresini yalnız işletme sahibi değiştirebilir.");
  }
  if (
    minutes !== null &&
    (!Number.isInteger(minutes) ||
      minutes < OPTION_SETTINGS_LIMITS.minMinutes ||
      minutes > OPTION_SETTINGS_LIMITS.maxMinutes)
  ) {
    throw validationError({ defaultDuration: ["Süre 1 saat ile 14 gün arasında olmalı."] });
  }
  try {
    await tx.execute(sql`savepoint option_owner_default`);
    const res = await tx.execute<{ out: string }>(
      sql`select public.app_option_owner_set_default(${minutes}::integer) as out`,
    );
    await tx.execute(sql`release savepoint option_owner_default`);
    return { changed: res.rows[0]?.out === "changed" };
  } catch (err) {
    await tx.execute(sql`rollback to savepoint option_owner_default`);
    const pg = pgErrorInfo(err);
    if (pg.code === PG.INSUFFICIENT_PRIVILEGE) throw forbidden();
    if (pg.code === PG.CHECK_VIOLATION) {
      throw validationError({
        defaultDuration: ["Bu süre kullanılamaz (1 saat – 14 gün; tanımlı seçeneklerden biri)."],
      });
    }
    throw err;
  }
}

/** Açıklama bekleyen opsiyon işlemleri (Faz A: salt okunur), en yeniler önce. */
export async function listOwnerClarifications(
  tx: Tx,
  ctx: TenantContext,
  limit = 50,
): Promise<OwnerClarification[]> {
  if (!canSee(ctx)) throw forbidden();
  const n = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const res = await tx.execute<{
    id: string;
    property_name: string;
    check_in: string | null;
    check_out: string | null;
    reasons: string[] | null;
    sent_at: Date | string | null;
    created_at: Date | string;
  }>(sql`
    select op.id, p.name as property_name, op.check_in::text, op.check_out::text, op.reasons,
           op.sent_at, op.created_at
      from option_operations op
      join properties p on p.id = op.property_id
     where op.workspace_id = app_current_workspace_id()
       and op.mode = 'clarify' and op.status = 'pending'
     order by op.created_at desc
     limit ${n}`);
  return res.rows.map((r) => ({
    id: r.id,
    propertyName: r.property_name,
    checkIn: r.check_in,
    checkOut: r.check_out,
    reasons: r.reasons ?? [],
    sentAt: r.sent_at === null ? null : new Date(r.sent_at),
    createdAt: new Date(r.created_at),
  }));
}
