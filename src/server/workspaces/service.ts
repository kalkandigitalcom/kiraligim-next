import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";

import { PG, pgErrorInfo } from "@/db/pg-error";
import { type MemberRole, type TenantContext, type Tx, withUser } from "@/db/tenant";
import { AppError, conflict, forbidden, notFound, validationError } from "@/lib/errors";
import { zodFieldErrors } from "@/lib/result";
import { recordAudit } from "@/server/audit/record";

type AnyDb = Parameters<typeof withUser>[0];

/** Alt alan adı, panel ve sistem yolu olarak ayrılmış adlar. */
export const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "dev",
  "destek",
  "docs",
  "help",
  "mail",
  "panel",
  "root",
  "staging",
  "static",
  "status",
  "support",
  "system",
  "test",
  "www",
  "yardim",
]);

export const createWorkspaceInput = z.object({
  name: z.string().trim().min(2, "En az 2 karakter").max(120, "En fazla 120 karakter"),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/, "3–48 karakter: küçük harf, rakam ve tire")
    .refine((s) => !RESERVED_SLUGS.has(s), "Bu adres kullanılamaz"),
});

export type WorkspaceSummary = { id: string; name: string; slug: string; role: MemberRole };

/**
 * Workspace oluşturur: workspace + ilk owner üyeliği + denetim kaydı TEK transaction'da.
 * Herhangi bir adım başarısız olursa hiçbiri kalıcı olmaz.
 */
export async function createWorkspace(
  db: AnyDb,
  input: { userId: string; name: string; slug: string },
): Promise<WorkspaceSummary> {
  const parsed = createWorkspaceInput.safeParse(input);
  if (!parsed.success) throw validationError(zodFieldErrors(parsed.error));
  const { name, slug } = parsed.data;
  const workspaceId = uuidv7();

  try {
    return await withUser(db, input.userId, async (tx) => {
      // Yeni workspace'in bağlamı: RLS ekleme kuralları (workspaces_insert, members_insert ilk owner)
      // bu kimlikle eşleşmeyi şart koşar.
      await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
      // RETURNING kullanılmaz: ekleme anında kullanıcı henüz üye olmadığından RLS satırı göstermez.
      await tx.execute(sql`
        insert into workspaces (id, name, slug, created_by)
        values (${workspaceId}, ${name}, ${slug}, app_current_user_id())`);
      const memberId = uuidv7();
      await tx.execute(sql`
        insert into workspace_members (id, workspace_id, user_id, role)
        values (${memberId}, ${workspaceId}, app_current_user_id(), 'owner')`);
      await recordAudit(tx, {
        action: "workspace.created",
        targetType: "workspace",
        targetId: workspaceId,
        metadata: { slug },
      });
      return { id: workspaceId, name, slug, role: "owner" as const };
    });
  } catch (err) {
    const pg = pgErrorInfo(err);
    if (pg.code === PG.UNIQUE_VIOLATION && pg.constraint === "workspaces_slug_key") {
      throw conflict("Bu adres zaten kullanımda.");
    }
    throw err;
  }
}

/** Kullanıcının üye olduğu aktif workspace'ler (workspace seçimi). */
export async function listMyWorkspaces(db: AnyDb, userId: string): Promise<WorkspaceSummary[]> {
  return withUser(db, userId, async (tx) => {
    const res = await tx.execute<WorkspaceSummary>(sql`
      select w.id, w.name, w.slug, m.role
        from workspace_members m join workspaces w on w.id = m.workspace_id
       where w.status = 'active'
       order by w.name`);
    return res.rows;
  });
}

/** Üye listesi: yalnız ad, rol ve üyelik tarihi. E-posta ve diğer kişisel bilgiler dönmez. */
export type MemberListItem = { memberId: string; name: string; role: MemberRole; joinedAt: Date };

export async function listWorkspaceMembers(tx: Tx): Promise<MemberListItem[]> {
  const res = await tx.execute<{
    member_id: string;
    name: string;
    role: MemberRole;
    joined_at: Date;
  }>(sql`
    select m.id as member_id, u.name, m.role, m.created_at as joined_at
      from workspace_members m join users u on u.id = m.user_id
     where m.workspace_id = app_current_workspace_id()
     order by m.created_at`);
  return res.rows.map((r) => ({
    memberId: r.member_id,
    name: r.name,
    role: r.role,
    joinedAt: new Date(r.joined_at),
  }));
}

function canAssign(actor: MemberRole, target: MemberRole): boolean {
  return actor === "owner" || (actor === "manager" && target === "staff");
}

function mapWriteError(err: unknown): never {
  const pg = pgErrorInfo(err);
  if (pg.code === PG.INSUFFICIENT_PRIVILEGE) throw forbidden();
  if (pg.code === PG.CHECK_VIOLATION && pg.message === "workspace_last_owner") {
    throw new AppError("CONFLICT", "İşletmenin en az bir sahibi olmalı.");
  }
  if (pg.code === PG.UNIQUE_VIOLATION) throw conflict("Bu kullanıcı zaten üye.");
  throw err;
}

/** Üye ekler (owner: her rol; manager: yalnız staff). withTenant içinde çağrılır. */
export async function addWorkspaceMember(
  tx: Tx,
  ctx: TenantContext,
  input: { userId: string; role: MemberRole },
): Promise<string> {
  if (!canAssign(ctx.role, input.role)) throw forbidden();
  const memberId = uuidv7();
  try {
    await tx.execute(sql`savepoint add_member`);
    await tx.execute(sql`
      insert into workspace_members (id, workspace_id, user_id, role)
      values (${memberId}, app_current_workspace_id(), ${input.userId}, ${input.role})`);
    await tx.execute(sql`release savepoint add_member`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint add_member`);
    mapWriteError(err);
  }
  await recordAudit(tx, {
    action: "workspace.member_added",
    targetType: "workspace_member",
    targetId: memberId,
    metadata: { role: input.role },
  });
  return memberId;
}

/**
 * Rol değiştirir (yalnız owner). Son owner'ın rolü düşürülemez.
 * Satır FOR UPDATE ile kilitlenir; böylece okunan eski rol (`from`) güncellemeye kadar değişemez.
 * UPDATE tam 1 satırı (eski rol hâlâ `from` iken) değiştirmezse denetim kaydı yazılmaz.
 */
export async function changeMemberRole(
  tx: Tx,
  ctx: TenantContext,
  input: { memberId: string; role: MemberRole },
): Promise<void> {
  if (ctx.role !== "owner") throw forbidden();
  let from: MemberRole | undefined;
  try {
    await tx.execute(sql`savepoint change_role`);
    const current = await tx.execute<{ role: MemberRole }>(sql`
      select role from workspace_members where id = ${input.memberId} for update`);
    from = current.rows[0]?.role;
    if (from && from !== input.role) {
      const res = await tx.execute(sql`
        update workspace_members set role = ${input.role}
         where id = ${input.memberId} and role = ${from}`);
      if (res.rowCount !== 1) {
        throw new AppError("CONFLICT", "Üye rolü değiştirilemedi; lütfen tekrar deneyin.");
      }
    }
    await tx.execute(sql`release savepoint change_role`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint change_role`);
    if (err instanceof AppError) throw err;
    mapWriteError(err);
  }
  if (!from) throw notFound("Üye bulunamadı.");
  if (from === input.role) return;
  await recordAudit(tx, {
    action: "workspace.member_role_changed",
    targetType: "workspace_member",
    targetId: input.memberId,
    metadata: { from, to: input.role },
  });
}

/** Üyeyi çıkarır (yalnız owner). Son owner çıkarılamaz. */
export async function removeWorkspaceMember(
  tx: Tx,
  ctx: TenantContext,
  memberId: string,
): Promise<void> {
  if (ctx.role !== "owner") throw forbidden();
  let role: MemberRole | undefined;
  try {
    await tx.execute(sql`savepoint remove_member`);
    const res = await tx.execute<{ role: MemberRole }>(sql`
      delete from workspace_members where id = ${memberId} returning role`);
    role = res.rows[0]?.role;
    await tx.execute(sql`release savepoint remove_member`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint remove_member`);
    mapWriteError(err);
  }
  if (!role) throw notFound("Üye bulunamadı.");
  await recordAudit(tx, {
    action: "workspace.member_removed",
    targetType: "workspace_member",
    targetId: memberId,
    metadata: { role },
  });
}
