/**
 * Bağımlılıksız JSON logger. Her satır tek bir JSON nesnesidir (Coolify log görüntüleyicisi için).
 * Hassas alan adları otomatik maskelenir.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE =
  /pass(word)?|secret|token|authorization|cookie|api[-_]?key|kek|dek|tc_?kimlik|identity_number/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[derin]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE.test(k) ? "[gizli]" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    // URL içindeki parolayı gizle: postgres://user:parola@host
    return value.replace(/(\w+:\/\/[^:/\s]+:)[^@\s]+@/g, "$1[gizli]@");
  }
  return value;
}

function threshold(): number {
  const fromEnv = process.env.LOG_LEVEL as LogLevel | undefined;
  const level =
    fromEnv && fromEnv in LEVELS
      ? fromEnv
      : process.env.NODE_ENV === "production"
        ? "info"
        : "debug";
  return LEVELS[level];
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(bindings: Fields): Logger;
}

export function createLogger(
  bindings: Fields = {},
  write: (line: string) => void = defaultWrite,
): Logger {
  const log = (level: LogLevel, msg: string, fields?: Fields) => {
    if (LEVELS[level] < threshold()) return;
    const entry = redact({ time: new Date().toISOString(), level, msg, ...bindings, ...fields });
    write(JSON.stringify(entry));
  };
  return {
    debug: (m, f) => log("debug", m, f),
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
    child: (b) => createLogger({ ...bindings, ...b }, write),
  };
}

function defaultWrite(line: string) {
  process.stdout.write(line + "\n");
}

export const logger = createLogger({ service: "web" });
