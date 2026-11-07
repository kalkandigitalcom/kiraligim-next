/** Drizzle'ın sardığı node-postgres hatasından SQLSTATE, kısıt ve mesajı çıkarır. */
export type PgErrorInfo = { code?: string; constraint?: string; message?: string };

export function pgErrorInfo(err: unknown): PgErrorInfo {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const e = cur as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) {
      return {
        code: e.code,
        ...(typeof e.constraint === "string" ? { constraint: e.constraint } : {}),
        ...(typeof e.message === "string" ? { message: e.message } : {}),
      };
    }
    cur = e.cause;
  }
  return {};
}

export const PG = {
  UNIQUE_VIOLATION: "23505",
  CHECK_VIOLATION: "23514",
  FOREIGN_KEY_VIOLATION: "23503",
  EXCLUSION_VIOLATION: "23P01",
  INSUFFICIENT_PRIVILEGE: "42501",
} as const;
