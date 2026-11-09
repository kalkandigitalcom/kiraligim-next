/**
 * Baileys'e verilen günlükleyici. Baileys'in iç günlükleri anahtar, QR ve ham düğüm içerebilir;
 * bu yüzden nesneler HİÇ yazılmaz: yalnız warn/error düzeyinde kısa mesaj ve hata adı.
 */
import type { SocketConfig } from "baileys";

type ILogger = SocketConfig["logger"];

const safeText = (msg: unknown) =>
  typeof msg === "string" ? msg.replace(/[A-Za-z0-9+/=_-]{40,}/g, "[gizli]").slice(0, 200) : "";

const errorName = (obj: unknown) => {
  const err =
    obj instanceof Error
      ? obj
      : obj && typeof obj === "object" && "err" in obj && obj.err instanceof Error
        ? obj.err
        : null;
  return err ? `${err.name}: ${safeText(err.message)}` : "";
};

export function createSafeLogger(prefix = "baileys"): ILogger {
  const write = (level: "warn" | "error", obj: unknown, msg?: string) => {
    const text = [safeText(msg ?? (typeof obj === "string" ? obj : "")), errorName(obj)]
      .filter(Boolean)
      .join(" — ");
    if (text) console[level](`[${prefix}] ${level}: ${text}`);
  };
  const logger: ILogger = {
    level: "warn",
    child: () => logger,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (obj, msg) => write("warn", obj, msg),
    error: (obj, msg) => write("error", obj, msg),
  };
  return logger;
}
