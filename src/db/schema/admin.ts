import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Super Admin (platform yönetimi, admin.<alan-adı>) — Aşama 2.8 minimal (drizzle/0041, 0042).
 *
 * İşletme kimlik sisteminden (Better Auth: users, sessions…) TAMAMEN AYRIDIR: ayrı tablolar,
 * ayrı çerez, ayrı veritabanı rolü (app_admin, DATABASE_ADMIN_URL). app_user bu tablolara hiçbir
 * yetkiye sahip değildir; app_admin işletme tablolarını doğrudan okuyamaz (yalnız ileride verilecek
 * dar SECURITY DEFINER fonksiyonlarla).
 *
 * Güvenlik:
 *  - şifre scrypt özeti; TOTP sırrı AES-256-GCM ile şifreli (anahtar ADMIN_SECRET_KEY, veritabanında
 *    yok); ikinci adım (TOTP) ZORUNLU; aynı TOTP adımı ikinci kez kullanılamaz;
 *  - oturum ve giriş adımı belirteçleri yalnız SHA-256 özetiyle saklanır;
 *  - art arda hatalı girişte hesap süreli kilitlenir;
 *  - her giriş, çıkış ve yönetim işlemi admin_audit_log'a yazılır (yalnız eklenir).
 */
const ts = () => timestamp({ withTimezone: true, mode: "date" });

export const ADMIN_STATUSES = ["active", "disabled"] as const;

export const adminUsers = pgTable(
  "admin_users",
  {
    id: uuid().primaryKey(),
    /** Küçük harf, kırpılmış. */
    email: text().notNull(),
    name: text().notNull(),
    passwordHash: text().notNull(),
    /** AES-256-GCM ile şifrelenmiş base32 TOTP sırrı ("v1:iv:etiket:şifreli", base64url). */
    totpSecretEnc: text().notNull(),
    /** Son kabul edilen TOTP adımı (30 sn): aynı kod ikinci kez kullanılamaz. */
    totpLastStep: bigint({ mode: "number" }),
    status: text({ enum: ADMIN_STATUSES }).notNull().default("active"),
    failedCount: integer().notNull().default(0),
    lockedUntil: ts(),
    lastLoginAt: ts(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("admin_users_email_key").on(t.email),
    check("admin_users_status_check", sql`${t.status} in ('active', 'disabled')`),
    check(
      "admin_users_email_format",
      sql`${t.email} = lower(btrim(${t.email})) and length(${t.email}) between 3 and 254 and ${t.email} like '%_@_%'`,
    ),
    check("admin_users_name_length", sql`length(btrim(${t.name})) between 1 and 100`),
    check("admin_users_password_format", sql`${t.passwordHash} ~ '^scrypt\\$'`),
    check("admin_users_totp_format", sql`${t.totpSecretEnc} ~ '^v1:'`),
    check("admin_users_failed_count", sql`${t.failedCount} >= 0`),
  ],
);

/** Şifre doğrulandıktan sonra TOTP bekleyen kısa ömürlü adım (5 dk, en fazla 5 deneme). */
export const adminLoginChallenges = pgTable(
  "admin_login_challenges",
  {
    id: uuid().primaryKey(),
    adminId: uuid()
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    tokenHash: text().notNull(),
    attempts: integer().notNull().default(0),
    expiresAt: ts().notNull(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("admin_login_challenges_token_key").on(t.tokenHash),
    index("admin_login_challenges_admin_idx").on(t.adminId),
    check("admin_login_challenges_token_format", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("admin_login_challenges_attempts", sql`${t.attempts} between 0 and 10`),
  ],
);

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid().primaryKey(),
    adminId: uuid()
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    tokenHash: text().notNull(),
    createdAt: ts().notNull().defaultNow(),
    lastSeenAt: ts().notNull().defaultNow(),
    /** Mutlak süre sonu (boşta kalma süresi ayrıca lastSeenAt'ten hesaplanır). */
    expiresAt: ts().notNull(),
    revokedAt: ts(),
  },
  (t) => [
    uniqueIndex("admin_sessions_token_key").on(t.tokenHash),
    index("admin_sessions_admin_idx").on(t.adminId),
    check("admin_sessions_token_format", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Platform yönetim denetim kaydı. Yalnız eklenir (güncelleme/silme yetkisi kimsede yok). */
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: uuid().primaryKey(),
    occurredAt: ts().notNull().defaultNow(),
    adminId: uuid().references(() => adminUsers.id, { onDelete: "set null" }),
    action: text().notNull(),
    targetType: text(),
    targetId: uuid(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index("admin_audit_log_occurred_idx").on(t.occurredAt.desc()),
    index("admin_audit_log_admin_idx").on(t.adminId),
    check("admin_audit_log_action_format", sql`${t.action} ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)+$'`),
    check(
      "admin_audit_log_metadata_object",
      sql`jsonb_typeof(${t.metadata}) = 'object' and pg_column_size(${t.metadata}) <= 4096`,
    ),
  ],
);
