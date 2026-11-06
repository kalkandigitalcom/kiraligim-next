import "server-only";

import {
  createLogTransport,
  createMemoryTransport,
  createResendTransport,
} from "@/lib/email/transports";
import type { EmailTransport } from "@/lib/email/types";

import { type AuthEnv, getAuthEnv } from "./env";

export function createEmailTransport(env: AuthEnv): EmailTransport {
  switch (env.EMAIL_TRANSPORT) {
    case "resend":
      return createResendTransport({
        apiKey: env.RESEND_API_KEY!,
        from: env.EMAIL_FROM,
        ...(env.EMAIL_REPLY_TO ? { replyTo: env.EMAIL_REPLY_TO } : {}),
      });
    case "log":
      return createLogTransport();
    case "memory":
      return createMemoryTransport();
  }
}

let cached: EmailTransport | undefined;

export function getEmailTransport(): EmailTransport {
  cached ??= createEmailTransport(getAuthEnv());
  return cached;
}
