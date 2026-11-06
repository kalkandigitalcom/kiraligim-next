import "server-only";

import { getPool } from "@/db/client";
import { type DbRoleReport, inspectDbRole } from "@/db/role-check";

import { getEnv } from "./env";
import { logger } from "./logger";

/**
 * DB_ROLE_GUARD:
 *   warn    (varsayılan) güvensiz rol log'a hata olarak yazılır, uygulama çalışmaya devam eder
 *   enforce güvensiz rolde /api/health 503 döner → Coolify yeni sürümü devreye almaz
 * Sonuç süreç başına bir kez hesaplanır (rol çalışma sırasında değişmez).
 */

export type RoleGuardStatus = "ok" | "unsafe" | "unknown";

// instrumentation ve route handler'lar ayrı modül örnekleri olabildiği için durum süreç genelinde tutulur.
type GuardState = { report?: DbRoleReport; logged: boolean };
const g = globalThis as unknown as { __kiraligimRoleGuard?: GuardState };
const state = (): GuardState => (g.__kiraligimRoleGuard ??= { logged: false });

export async function checkDbRole(): Promise<RoleGuardStatus> {
  const s = state();
  try {
    s.report ??= await inspectDbRole(getPool());
  } catch (err) {
    logger.error("db_role_check_failed", { err });
    return "unknown";
  }

  const report = s.report;
  if (!s.logged) {
    s.logged = true;
    const fields = { role: report.role, findings: report.findings, mode: getEnv().DB_ROLE_GUARD };
    if (report.safe) logger.info("db_role_check_ok", fields);
    else logger.error("db_role_check_unsafe", fields);
  }
  return report.safe ? "ok" : "unsafe";
}

/** Health check'in bu rol nedeniyle başarısız sayılıp sayılmayacağı. */
export function roleGuardFails(status: RoleGuardStatus): boolean {
  return getEnv().DB_ROLE_GUARD === "enforce" && status !== "ok";
}

/** Yalnız testler için. */
export function resetDbRoleGuard(): void {
  g.__kiraligimRoleGuard = { logged: false };
}
