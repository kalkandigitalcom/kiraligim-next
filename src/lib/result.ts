import type { ZodError } from "zod";

import { AppError, type ErrorCode, type FieldErrors, GENERIC_ERROR_MESSAGE } from "./errors";
import { logger } from "./logger";

/** Server action'ların tek tip dönüş değeri. İstemci hiçbir zaman ham hata görmez. */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string; fieldErrors?: FieldErrors } };

export const ok = <T>(data: T): ActionResult<T> => ({ ok: true, data });

export function zodFieldErrors(error: ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

export function toActionError(
  err: unknown,
  context: Record<string, unknown> = {},
): ActionResult<never> {
  if (err instanceof AppError && err.expose) {
    return {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}),
      },
    };
  }
  logger.error("action_failed", { ...context, err });
  return { ok: false, error: { code: "INTERNAL", message: GENERIC_ERROR_MESSAGE } };
}

/** Bir action gövdesini sarar; fırlatılan hataları ActionResult'a çevirir. */
export async function runAction<T>(name: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return ok(await fn());
  } catch (err) {
    return toActionError(err, { action: name });
  }
}
