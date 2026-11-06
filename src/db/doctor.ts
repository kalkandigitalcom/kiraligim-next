/**
 * Bağlantı rolünü denetleyen komut: `node dist/db-doctor.js`
 * Coolify terminalinde uygulama konteynerinde çalıştırılır; DATABASE_URL ile bağlanır,
 * yalnız okur. Güvensizse 2 koduyla çıkar.
 */
import { createLogger } from "../lib/logger";
import { createPool } from "./pool";
import { inspectDbRole } from "./role-check";

const log = createLogger({ service: "db-doctor" });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL tanımlı değil");
  const pool = createPool(url, { max: 1, application_name: "kiraligim-db-doctor" });
  try {
    const report = await inspectDbRole(pool);
    if (report.safe) {
      log.info("db_role_safe", { role: report.role });
    } else {
      log.error("db_role_unsafe", { role: report.role, findings: report.findings });
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  log.error("db_doctor_failed", { err });
  process.exit(1);
});
