/**
 * Uygulama hata tipleri. `expose: true` olan hataların mesajı kullanıcıya gösterilebilir;
 * diğerleri loglanır ve kullanıcıya genel bir mesaj döner.
 */

export type ErrorCode =
  | "VALIDATION"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "LIMIT_REACHED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  LIMIT_REACHED: 402,
  INTERNAL: 500,
};

export type FieldErrors = Record<string, string[]>;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly fieldErrors?: FieldErrors;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { expose?: boolean; fieldErrors?: FieldErrors; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.expose = opts.expose ?? code !== "INTERNAL";
    if (opts.fieldErrors) this.fieldErrors = opts.fieldErrors;
  }
}

export const validationError = (fieldErrors: FieldErrors, message = "Lütfen formu kontrol edin.") =>
  new AppError("VALIDATION", message, { fieldErrors });
export const unauthorized = (message = "Oturum açmanız gerekiyor.") =>
  new AppError("UNAUTHORIZED", message);
export const forbidden = (message = "Bu işlem için yetkiniz yok.") =>
  new AppError("FORBIDDEN", message);
export const notFound = (message = "Kayıt bulunamadı.") => new AppError("NOT_FOUND", message);
export const conflict = (message: string) => new AppError("CONFLICT", message);
export const limitReached = (message: string) => new AppError("LIMIT_REACHED", message);

export const GENERIC_ERROR_MESSAGE = "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.";

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
