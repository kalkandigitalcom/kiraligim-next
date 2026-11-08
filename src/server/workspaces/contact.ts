import { sql } from "drizzle-orm";

import { PG, pgErrorInfo } from "@/db/pg-error";
import type { TenantContext, Tx } from "@/db/tenant";
import { AppError, forbidden, validationError } from "@/lib/errors";
import { recordAudit } from "@/server/audit/record";
import { whatsappInput } from "@/server/properties/public-profile-schema";

/**
 * İşletme iletişim bilgisi (F1): müşteriye açık villa sayfalarındaki WhatsApp numarası. İşletme
 * düzeyindedir; yalnız owner düzenler (RLS workspaces_update + kolon yetkisi drizzle/0023), tüm
 * üyeler görür. withTenant içinden çağrılır.
 */

export async function getWorkspaceWhatsapp(tx: Tx): Promise<string | null> {
  const res = await tx.execute<{ contact_whatsapp: string | null }>(sql`
    select contact_whatsapp from workspaces where id = app_current_workspace_id()`);
  return res.rows[0]?.contact_whatsapp ?? null;
}

/** Numarayı kaydeder ya da (boş gönderilirse) kaldırır. Döner: değişti mi. */
export async function updateWorkspaceWhatsapp(
  tx: Tx,
  ctx: TenantContext,
  input: unknown,
): Promise<{ changed: boolean; value: string | null }> {
  if (ctx.role !== "owner")
    throw forbidden("WhatsApp numarasını yalnız işletme sahibi değiştirebilir.");
  const parsed = whatsappInput.safeParse(input);
  if (!parsed.success) {
    throw validationError({ whatsapp: [parsed.error.issues[0]?.message ?? "Geçersiz numara."] });
  }
  const value = parsed.data;
  try {
    await tx.execute(sql`savepoint workspace_contact`);
    const cur = await tx.execute<{ contact_whatsapp: string | null }>(sql`
      select contact_whatsapp from workspaces where id = app_current_workspace_id() for update`);
    if (cur.rows.length === 0) throw new AppError("NOT_FOUND", "İşletme bulunamadı.");
    if (cur.rows[0]!.contact_whatsapp === value) {
      await tx.execute(sql`release savepoint workspace_contact`);
      return { changed: false, value };
    }
    const res = await tx.execute(sql`
      update workspaces set contact_whatsapp = ${value} where id = app_current_workspace_id()`);
    if (res.rowCount !== 1) throw forbidden();
    await tx.execute(sql`release savepoint workspace_contact`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint workspace_contact`);
    if (err instanceof AppError) throw err;
    const pg = pgErrorInfo(err);
    if (pg.code === PG.INSUFFICIENT_PRIVILEGE) throw forbidden();
    if (pg.code === PG.CHECK_VIOLATION) throw validationError({ whatsapp: ["Geçersiz numara."] });
    throw err;
  }
  await recordAudit(tx, {
    action: "workspace.updated",
    targetType: "workspace",
    targetId: ctx.workspaceId,
    metadata: { fields: ["contact_whatsapp"] },
  });
  return { changed: true, value };
}
