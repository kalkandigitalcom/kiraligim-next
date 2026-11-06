import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Ev sahibi kimlik tabloları (Better Auth, app.<alan-adı>).
 *
 * Better Auth bu tablolara Drizzle adaptörü üzerinden `usePlural: true` ile erişir:
 *   user → users, session → sessions, account → accounts, verification → verifications,
 *   rateLimit → rateLimits (yalnız rateLimit.storage = "database" iken).
 * Adaptör tabloları bu dosyanın export adlarıyla, kolonları TypeScript alan adlarıyla bulur;
 * veritabanındaki kolon adları DB_CASING (snake_case) ile üretilir: emailVerified → email_verified.
 * Eşleşme tests/unit/auth-schema.test.ts ile Better Auth'un kendi tablo tanımına karşı doğrulanır.
 *
 * Kimlikler UUID v7'dir ve Better Auth tarafından üretilir (advanced.database.generateId).
 * Bu tablolarda RLS yoktur: Better Auth tenant bağlamı olmadan sorgular. Koruma, migration'da
 * app_user'a verilecek dar yetkilerle sağlanır. Super Admin kimliği bu tabloları KULLANMAZ.
 */

const timestamps = {
  createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
};

export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey(),
    name: text().notNull(),
    email: text().notNull(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    ...timestamps,
  },
  (t) => [
    unique("users_email_key").on(t.email),
    // Better Auth e-postayı küçük harfe çevirerek saklar; veritabanı da bunu zorunlu kılar,
    // böylece "Ali@x.com" ve "ali@x.com" iki ayrı hesap olamaz.
    check("users_email_lowercase", sql`${t.email} = lower(${t.email})`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid().primaryKey(),
    expiresAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    token: text().notNull(),
    ...timestamps,
    ipAddress: text(),
    userAgent: text(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [unique("sessions_token_key").on(t.token), index("sessions_user_id_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true, mode: "date" }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true, mode: "date" }),
    scope: text(),
    // Better Auth'un scrypt şifre özeti (yalnız providerId = "credential" hesaplarında).
    password: text(),
    ...timestamps,
  },
  (t) => [
    index("accounts_user_id_idx").on(t.userId),
    unique("accounts_provider_account_key").on(t.providerId, t.accountId),
  ],
);

export const verifications = pgTable(
  "verifications",
  {
    id: uuid().primaryKey(),
    // verification.storeIdentifier = "hashed": şifre sıfırlama vb. belirteçler özet olarak saklanır.
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    ...timestamps,
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

/**
 * Giriş/kayıt deneme sınırı. Better Auth bu tabloyu yalnız `rateLimit.storage: "database"` iken
 * kullanır (better-auth/dist/api/rate-limiter): anahtar başına satır okur (findMany), yoksa
 * ekler (create), koşullu atomik UPDATE ile sayar (incrementOne), süresi geçen satırları siler
 * (deleteMany). Anahtar "<istemci-ip>|<yol>" biçimindedir; lastRequest Unix zamanı (ms).
 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    id: uuid().primaryKey(),
    key: text().notNull(),
    count: integer().notNull(),
    lastRequest: bigint({ mode: "number" }).notNull(),
  },
  (t) => [
    unique("rate_limits_key_key").on(t.key),
    index("rate_limits_last_request_idx").on(t.lastRequest),
  ],
);

export const authSchema = { users, sessions, accounts, verifications, rateLimits };
