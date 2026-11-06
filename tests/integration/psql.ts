/**
 * Gerçek scripts/db-bootstrap.sql dosyasını psql ile çalıştırır.
 * - CI ve sunucu: yerel `psql` (PSQL_CMD boş).
 * - Mac: konteyner içindeki psql (PSQL_CMD="docker exec -i -e KG_MIGRATOR_PASSWORD -e KG_APP_PASSWORD <ad> psql").
 * Parolalar, script'in beklediği gibi komut satırından değil ortam değişkeninden verilir.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type BootstrapInput = {
  dbName: string;
  migratorPassword?: string;
  appPassword?: string;
};

export function runBootstrap(input: BootstrapInput) {
  const adminUrl = process.env.PSQL_URL ?? process.env.TEST_ADMIN_DATABASE_URL ?? "";
  const [bin, ...pre] = (process.env.PSQL_CMD ?? "psql").split(" ").filter(Boolean);
  const sql = fs.readFileSync(path.resolve(__dirname, "../../scripts/db-bootstrap.sql"), "utf8");

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.KG_MIGRATOR_PASSWORD;
  delete env.KG_APP_PASSWORD;
  if (input.migratorPassword !== undefined) env.KG_MIGRATOR_PASSWORD = input.migratorPassword;
  if (input.appPassword !== undefined) env.KG_APP_PASSWORD = input.appPassword;

  const res = spawnSync(
    bin!,
    [...pre, adminUrl, "-X", "-v", "ON_ERROR_STOP=1", "-v", `db_name=${input.dbName}`, "-f", "-"],
    { input: sql, encoding: "utf8", env },
  );
  return {
    status: res.status,
    output: `${res.stdout ?? ""}${res.stderr ?? ""}${res.error ? String(res.error) : ""}`,
    args: [...pre, adminUrl, "-X", "-v", "ON_ERROR_STOP=1", "-v", `db_name=${input.dbName}`],
  };
}
