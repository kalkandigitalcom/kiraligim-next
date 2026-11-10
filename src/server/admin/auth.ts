/**
 * Super Admin kimlik doğrulaması (Aşama 2.8 minimal). İşletme kimlik sisteminden AYRI.
 *
 * Akış: e-posta + şifre → kısa ömürlü giriş adımı (5 dk, en fazla 5 TOTP denemesi) → TOTP (zorunlu)
 * → oturum (mutlak 12 saat, 2 saat hareketsizlikte biter). Belirteçler yalnız SHA-256 özetiyle
 * saklanır. Art arda 5 hatalı deneme (şifre veya TOTP) hesabı 15 dakika kilitler. Hatalar genel
 * mesajla döner: hesap varlığı, devre dışı olması veya hangi adımın yanlış olduğu sızdırılmaz.
 * Her giriş/çıkış/başarısız deneme admin_audit_log'a yazılır (şifre, kod, belirteç yazılmaz).
 *
 * Saf servis: veritabanı bağlantısı (app_admin) ve anahtar çağırandan gelir; Next.js'e bağımlı
 * değildir (komut satırı aracı da kullanır).
 */
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";

import type { Database } from "@/db/client";

import { decryptSecret, encryptSecret, randomToken, sha256Hex } from "./crypto";
import {
  adminPasswordProblem,
  burnPasswordTime,
  hashAdminPassword,
  verifyAdminPassword,
} from "./password";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp";

type AdminDb = Database;
type Tx = Parameters<Parameters<AdminDb["transaction"]>[0]>[0];
type Exec = Pick<AdminDb, "execute"> | Tx;

export const ADMIN_LIMITS = {
  maxFailures: 5,
  lockMinutes: 15,
  challengeMinutes: 5,
  challengeAttempts: 5,
  sessionHours: 12,
  idleMinutes: 120,
  /** lastSeenAt bu kadar dakikada bir güncellenir (her istekte yazılmaz). */
  touchMinutes: 5,
} as const;

export const ADMIN_AUDIT_ACTIONS = [
  "admin.user_created",
  "admin.user_disabled",
  "admin.user_enabled",
  "admin.totp_reset",
  "admin.password_reset",
  "admin.login",
  "admin.login_failed",
  "admin.logout",
] as const;
export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

export async function recordAdminAudit(
  tx: Exec,
  entry: {
    adminId: string | null;
    action: AdminAuditAction | `whatsapp.${string}`;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
    values (${uuidv7()}, ${entry.adminId}, ${entry.action}, ${entry.targetType ?? null},
            ${entry.targetId ?? null}, ${JSON.stringify(entry.metadata ?? {})}::jsonb)`);
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AdminSetupError extends Error {}

// ---------------------------------------------------------------------------------------------
// Hesap yönetimi (yalnız komut satırı aracı: dist/admin-user.js)
// ---------------------------------------------------------------------------------------------

export async function createAdminUser(
  db: AdminDb,
  input: { email: string; name: string; password: string },
  key: Buffer,
  issuer = "Kiralığım Yönetim",
): Promise<{ id: string; secret: string; uri: string }> {
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email) || email.length > 254) throw new AdminSetupError("E-posta geçersiz.");
  const name = input.name.trim();
  if (!name || name.length > 100) throw new AdminSetupError("Ad 1–100 karakter olmalı.");
  const pwProblem = adminPasswordProblem(input.password);
  if (pwProblem) throw new AdminSetupError(pwProblem);
  const secret = generateTotpSecret();
  const id = uuidv7();
  const hash = await hashAdminPassword(input.password);
  await db.transaction(async (tx) => {
    const exists = await tx.execute(sql`select 1 from admin_users where email = ${email}`);
    if (exists.rows.length > 0) throw new AdminSetupError("Bu e-postayla bir yönetici zaten var.");
    await tx.execute(sql`
      insert into admin_users (id, email, name, password_hash, totp_secret_enc)
      values (${id}, ${email}, ${name}, ${hash}, ${encryptSecret(secret, key)})`);
    await recordAdminAudit(tx, {
      adminId: null,
      action: "admin.user_created",
      targetType: "admin_user",
      targetId: id,
    });
  });
  return { id, secret, uri: otpauthUri(issuer, email, secret) };
}

async function adminIdByEmail(tx: Exec, email: string): Promise<string> {
  const r = await tx.execute<{ id: string }>(
    sql`select id from admin_users where email = ${normalizeEmail(email)} for update`,
  );
  const id = r.rows[0]?.id;
  if (!id) throw new AdminSetupError("Yönetici bulunamadı.");
  return id;
}

const revokeAll = (tx: Exec, adminId: string) =>
  tx.execute(sql`
    update admin_sessions set revoked_at = now()
     where admin_id = ${adminId} and revoked_at is null`);

/** Yeni TOTP sırrı (kayıp telefon). Tüm oturumlar kapanır. */
export async function resetAdminTotp(
  db: AdminDb,
  email: string,
  key: Buffer,
  issuer = "Kiralığım Yönetim",
): Promise<{ secret: string; uri: string }> {
  const secret = generateTotpSecret();
  await db.transaction(async (tx) => {
    const id = await adminIdByEmail(tx, email);
    await tx.execute(sql`
      update admin_users set totp_secret_enc = ${encryptSecret(secret, key)}, totp_last_step = null,
             updated_at = now() where id = ${id}`);
    await revokeAll(tx, id);
    await tx.execute(sql`delete from admin_login_challenges where admin_id = ${id}`);
    await recordAdminAudit(tx, {
      adminId: null,
      action: "admin.totp_reset",
      targetType: "admin_user",
      targetId: id,
    });
  });
  return { secret, uri: otpauthUri(issuer, normalizeEmail(email), secret) };
}

/** Şifre yenileme (komut satırı). Tüm oturumlar kapanır, kilit kalkar. */
export async function resetAdminPassword(
  db: AdminDb,
  email: string,
  password: string,
): Promise<void> {
  const problem = adminPasswordProblem(password);
  if (problem) throw new AdminSetupError(problem);
  const hash = await hashAdminPassword(password);
  await db.transaction(async (tx) => {
    const id = await adminIdByEmail(tx, email);
    await tx.execute(sql`
      update admin_users set password_hash = ${hash}, failed_count = 0, locked_until = null,
             updated_at = now() where id = ${id}`);
    await revokeAll(tx, id);
    await recordAdminAudit(tx, {
      adminId: null,
      action: "admin.password_reset",
      targetType: "admin_user",
      targetId: id,
    });
  });
}

/** Devre dışı bırakma / yeniden etkinleştirme. Devre dışı bırakınca tüm oturumlar kapanır. */
export async function setAdminStatus(
  db: AdminDb,
  email: string,
  status: "active" | "disabled",
): Promise<void> {
  await db.transaction(async (tx) => {
    const id = await adminIdByEmail(tx, email);
    await tx.execute(sql`
      update admin_users set status = ${status}, failed_count = 0, locked_until = null,
             updated_at = now() where id = ${id}`);
    if (status === "disabled") {
      await revokeAll(tx, id);
      await tx.execute(sql`delete from admin_login_challenges where admin_id = ${id}`);
    }
    await recordAdminAudit(tx, {
      adminId: null,
      action: status === "disabled" ? "admin.user_disabled" : "admin.user_enabled",
      targetType: "admin_user",
      targetId: id,
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Giriş
// ---------------------------------------------------------------------------------------------

export type LoginFailure = "invalid" | "locked" | "expired";

type UserRow = {
  id: string;
  password_hash: string;
  totp_secret_enc: string;
  totp_last_step: string | number | null;
  status: string;
  failed_count: number;
  locked_until: Date | string | null;
};

/** Sürücü zaman damgasını metin olarak verebilir (drizzle execute): her zaman Date'e çevrilir. */
const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

const minutesFrom = (now: Date, m: number) => new Date(now.getTime() + m * 60_000);

/** Hatalı deneme: sayaç artar; sınıra ulaşınca hesap süreli kilitlenir. */
async function registerFailure(
  tx: Exec,
  user: UserRow,
  now: Date,
  step: "password" | "totp",
): Promise<LoginFailure> {
  const count = Number(user.failed_count) + 1;
  const lock = count >= ADMIN_LIMITS.maxFailures;
  await tx.execute(sql`
    update admin_users
       set failed_count = ${lock ? 0 : count},
           locked_until = ${lock ? minutesFrom(now, ADMIN_LIMITS.lockMinutes) : null}
     where id = ${user.id}`);
  await recordAdminAudit(tx, {
    adminId: user.id,
    action: "admin.login_failed",
    metadata: { step, locked: lock },
  });
  return lock ? "locked" : "invalid";
}

const isLocked = (u: UserRow, now: Date) =>
  u.locked_until !== null && toDate(u.locked_until).getTime() > now.getTime();

/** 1. adım: e-posta + şifre. Başarılıysa TOTP adımı belirteci (çereze konur). */
export async function beginAdminLogin(
  db: AdminDb,
  input: { email: string; password: string },
  now: Date = new Date(),
): Promise<{ ok: true; challengeToken: string } | { ok: false; reason: LoginFailure }> {
  const email = normalizeEmail(input.email);
  const password = input.password;
  const found = await db.execute<UserRow>(sql`
    select id, password_hash, totp_secret_enc, totp_last_step, status, failed_count, locked_until
      from admin_users where email = ${email}`);
  const user = found.rows[0];
  if (!user || user.status !== "active") {
    await burnPasswordTime(password);
    return { ok: false, reason: "invalid" };
  }
  if (isLocked(user, now)) {
    await burnPasswordTime(password);
    return { ok: false, reason: "locked" };
  }
  const ok = await verifyAdminPassword(password, user.password_hash);
  return db.transaction(async (tx) => {
    // Eşzamanlı denemeler sayaçta kaybolmasın: satır kilitlenip yeniden okunur.
    const fresh = (
      await tx.execute<UserRow>(sql`
        select id, password_hash, totp_secret_enc, totp_last_step, status, failed_count, locked_until
          from admin_users where id = ${user.id} for update`)
    ).rows[0]!;
    if (fresh.status !== "active") return { ok: false as const, reason: "invalid" as const };
    if (isLocked(fresh, now)) return { ok: false as const, reason: "locked" as const };
    if (!ok)
      return { ok: false as const, reason: await registerFailure(tx, fresh, now, "password") };
    const token = randomToken();
    await tx.execute(sql`delete from admin_login_challenges where admin_id = ${fresh.id}`);
    await tx.execute(sql`
      insert into admin_login_challenges (id, admin_id, token_hash, expires_at)
      values (${uuidv7()}, ${fresh.id}, ${sha256Hex(token)},
              ${minutesFrom(now, ADMIN_LIMITS.challengeMinutes)})`);
    return { ok: true as const, challengeToken: token };
  });
}

/** 2. adım: TOTP. Başarılıysa oturum belirteci (çereze konur). */
export async function completeAdminLogin(
  db: AdminDb,
  input: { challengeToken: string; code: string },
  key: Buffer,
  now: Date = new Date(),
): Promise<
  { ok: true; sessionToken: string; expiresAt: Date } | { ok: false; reason: LoginFailure }
> {
  if (!input.challengeToken) return { ok: false, reason: "expired" };
  return db.transaction(async (tx) => {
    const ch = (
      await tx.execute<{
        id: string;
        admin_id: string;
        attempts: number;
        expires_at: Date | string;
      }>(sql`
        select id, admin_id, attempts, expires_at from admin_login_challenges
         where token_hash = ${sha256Hex(input.challengeToken)} for update`)
    ).rows[0];
    if (
      !ch ||
      toDate(ch.expires_at).getTime() <= now.getTime() ||
      Number(ch.attempts) >= ADMIN_LIMITS.challengeAttempts
    ) {
      if (ch) await tx.execute(sql`delete from admin_login_challenges where id = ${ch.id}`);
      return { ok: false as const, reason: "expired" as const };
    }
    const user = (
      await tx.execute<UserRow>(sql`
        select id, password_hash, totp_secret_enc, totp_last_step, status, failed_count, locked_until
          from admin_users where id = ${ch.admin_id} for update`)
    ).rows[0];
    if (!user || user.status !== "active") {
      await tx.execute(sql`delete from admin_login_challenges where id = ${ch.id}`);
      return { ok: false as const, reason: "expired" as const };
    }
    if (isLocked(user, now)) {
      await tx.execute(sql`delete from admin_login_challenges where id = ${ch.id}`);
      return { ok: false as const, reason: "locked" as const };
    }
    await tx.execute(
      sql`update admin_login_challenges set attempts = attempts + 1 where id = ${ch.id}`,
    );
    const secret = decryptSecret(user.totp_secret_enc, key);
    const last = user.totp_last_step === null ? null : Number(user.totp_last_step);
    const step = secret ? verifyTotp(secret, input.code, now.getTime(), last) : null;
    if (step === null) {
      const reason = await registerFailure(tx, user, now, "totp");
      if (reason === "locked") {
        await tx.execute(sql`delete from admin_login_challenges where id = ${ch.id}`);
      }
      return { ok: false as const, reason };
    }
    await tx.execute(sql`delete from admin_login_challenges where id = ${ch.id}`);
    await tx.execute(sql`
      update admin_users set totp_last_step = ${step}, failed_count = 0, locked_until = null,
             last_login_at = ${now} where id = ${user.id}`);
    const token = randomToken();
    const sessionId = uuidv7();
    const expiresAt = new Date(now.getTime() + ADMIN_LIMITS.sessionHours * 3_600_000);
    await tx.execute(sql`
      insert into admin_sessions (id, admin_id, token_hash, created_at, last_seen_at, expires_at)
      values (${sessionId}, ${user.id}, ${sha256Hex(token)}, ${now}, ${now}, ${expiresAt})`);
    await recordAdminAudit(tx, {
      adminId: user.id,
      action: "admin.login",
      targetType: "admin_session",
      targetId: sessionId,
    });
    return { ok: true as const, sessionToken: token, expiresAt };
  });
}

export type AdminIdentity = { adminId: string; email: string; name: string; sessionId: string };

/** Çerezdeki belirteçten geçerli oturum (iptal, mutlak süre, hareketsizlik, hesap durumu). */
export async function getAdminSession(
  db: AdminDb,
  token: string | undefined,
  now: Date = new Date(),
): Promise<AdminIdentity | null> {
  if (!token || token.length > 100) return null;
  const r = await db.execute<{
    session_id: string;
    admin_id: string;
    email: string;
    name: string;
    last_seen_at: Date | string;
  }>(sql`
    select s.id as session_id, s.admin_id, u.email, u.name, s.last_seen_at
      from admin_sessions s join admin_users u on u.id = s.admin_id
     where s.token_hash = ${sha256Hex(token)} and s.revoked_at is null and s.expires_at > ${now}
       and s.last_seen_at > ${new Date(now.getTime() - ADMIN_LIMITS.idleMinutes * 60_000)}
       and u.status = 'active'`);
  const s = r.rows[0];
  if (!s) return null;
  if (now.getTime() - toDate(s.last_seen_at).getTime() > ADMIN_LIMITS.touchMinutes * 60_000) {
    await db.execute(
      sql`update admin_sessions set last_seen_at = ${now} where id = ${s.session_id}`,
    );
  }
  return { adminId: s.admin_id, email: s.email, name: s.name, sessionId: s.session_id };
}

export async function revokeAdminSession(db: AdminDb, token: string | undefined): Promise<void> {
  if (!token || token.length > 100) return;
  await db.transaction(async (tx) => {
    const r = await tx.execute<{ id: string; admin_id: string }>(sql`
      update admin_sessions set revoked_at = now()
       where token_hash = ${sha256Hex(token)} and revoked_at is null
       returning id, admin_id`);
    const s = r.rows[0];
    if (s) {
      await recordAdminAudit(tx, {
        adminId: s.admin_id,
        action: "admin.logout",
        targetType: "admin_session",
        targetId: s.id,
      });
    }
  });
}

/** Süresi dolmuş adım ve oturum kayıtlarının temizliği (girişte fırsatçı çağrılır). */
export async function pruneAdminAuth(db: AdminDb, now: Date = new Date()): Promise<void> {
  await db.execute(sql`delete from admin_login_challenges where expires_at < ${now}`);
  await db.execute(sql`
    delete from admin_sessions
     where expires_at < ${new Date(now.getTime() - 30 * 86_400_000)}`);
}
