import "server-only";

import { getPool } from "@/db/client";

import { getEnv } from "./env";
import { logger } from "./logger";

export type HealthReport = {
  status: "ok" | "degraded";
  version: string;
  env: string;
  checks: { database: "ok" | "error" };
  time: string;
};

const DB_TIMEOUT_MS = 2_000;

export async function checkHealth(): Promise<HealthReport> {
  let envName = "unknown";
  let version = process.env.APP_VERSION || process.env.SOURCE_COMMIT?.slice(0, 12) || "dev";
  let database: "ok" | "error" = "error";

  try {
    const env = getEnv();
    envName = env.APP_ENV;
    version = env.APP_VERSION ?? version;
    await withTimeout(getPool().query("select 1"), DB_TIMEOUT_MS);
    database = "ok";
  } catch (err) {
    logger.error("health_check_failed", { err });
  }

  return {
    status: database === "ok" ? "ok" : "degraded",
    version,
    env: envName,
    checks: { database },
    time: new Date().toISOString(),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`zaman aşımı (${ms} ms)`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
