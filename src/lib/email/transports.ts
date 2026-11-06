import { AppError } from "../errors";
import { type Logger, logger as rootLogger } from "../logger";
import type { EmailMessage, EmailTransport } from "./types";

const log = rootLogger.child({ component: "email" });

/** "ali.veli@ornek.com" → "a***@ornek.com": log'larda adres açık yazılmaz. */
export function maskEmail(address: string): string {
  const [local = "", domain = ""] = address.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type ResendConfig = {
  apiKey: string;
  from: string;
  replyTo?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Resend REST API (https://resend.com/docs/api-reference/emails/send-email).
 * SDK yerine doğrudan fetch: bağımlılık yok. API anahtarı ve ileti içeriği asla log'a yazılmaz.
 */
export function createResendTransport(config: ResendConfig): EmailTransport {
  const doFetch = config.fetchImpl ?? fetch;
  return {
    name: "resend",
    async send(message) {
      let res: Response;
      try {
        res = await doFetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
            ...(message.idempotencyKey ? { "idempotency-key": message.idempotencyKey } : {}),
          },
          body: JSON.stringify({
            from: config.from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
            ...(config.replyTo ? { reply_to: config.replyTo } : {}),
            tags: [{ name: "category", value: message.category.replace(/[^A-Za-z0-9_-]/g, "_") }],
          }),
          signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
        });
      } catch (err) {
        log.error("email_send_failed", {
          category: message.category,
          to: maskEmail(message.to),
          reason: err instanceof Error ? err.name : "unknown",
        });
        throw new AppError("INTERNAL", "E-posta gönderilemedi", { expose: false, cause: err });
      }

      if (!res.ok) {
        // Yanıt gövdesi hata ayrıntısı içerebilir; yalnız durum kodu loglanır.
        log.error("email_send_failed", {
          category: message.category,
          to: maskEmail(message.to),
          status: res.status,
        });
        throw new AppError("INTERNAL", "E-posta gönderilemedi", { expose: false });
      }

      const body = (await res.json().catch(() => ({}))) as { id?: unknown };
      const id = typeof body.id === "string" ? body.id : null;
      log.info("email_sent", { category: message.category, to: maskEmail(message.to), id });
      return { id };
    },
  };
}

/**
 * Geliştirme: gönderim yapmaz, iletiyi log'a yazar (doğrulama bağlantısı dahil; yerelde
 * e-posta servisine gerek kalmadan akışı denemek için). Production'da kullanılamaz (env kuralı).
 */
export function createLogTransport(logger: Logger = log): EmailTransport {
  return {
    name: "log",
    async send(message) {
      logger.info("email_logged", {
        category: message.category,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
      return { id: null };
    },
  };
}

/** Test: iletileri bellekte tutar. */
export function createMemoryTransport(): EmailTransport & { outbox: EmailMessage[] } {
  const outbox: EmailMessage[] = [];
  return {
    name: "memory",
    outbox,
    async send(message) {
      outbox.push(message);
      return { id: `memory-${outbox.length}` };
    },
  };
}
