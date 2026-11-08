"use server";

import { createHash } from "node:crypto";

import { headers } from "next/headers";

import { getBrand } from "@/config/brand";
import { getDb } from "@/db/client";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { REQUEST_ERROR_MESSAGES, type RequestResult } from "@/lib/reservation-request";
import { getEmailTransport } from "@/server/auth/email";
import { createMemoryRateLimit } from "@/server/public/memory-rate-limit";
import { submitReservationRequest } from "@/server/public/reservation-request";

// IP başına 10 dakikada en fazla 5 deneme (süreç içi ek katman; asıl sınır veritabanında).
const limiter = createMemoryRateLimit({ limit: 5, windowMs: 10 * 60_000 });

/** İstemci IP'si: ters vekilin eklediği en sağdaki x-forwarded-for değeri; yalnız özet tutulur. */
async function clientKey(): Promise<string> {
  const h = await headers();
  const chain = (h.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ip = chain.at(-1) ?? h.get("x-real-ip") ?? "unknown";
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

function emailDeps() {
  try {
    return {
      transport: getEmailTransport(),
      brand: getBrand().name,
      appUrl: getEnv().APP_URL,
    };
  } catch (err) {
    // E-posta yapılandırılmamışsa talep yine kaydedilir; bildirim yalnız panelde görünür.
    logger.warn("reservation_request_email_unavailable", { err });
    return null;
  }
}

/**
 * Villa sayfasındaki rezervasyon talebi. Girdi düz nesnedir (istemci formu); doğrulama, fiyat ve
 * müsaitlik sunucuda (submitReservationRequest). Sonuç misafire gösterilebilir metin içerir.
 */
export async function requestReservationAction(input: unknown): Promise<RequestResult> {
  if (!limiter.take(await clientKey())) {
    return { ok: false, code: "rate_limited", message: REQUEST_ERROR_MESSAGES.rate_limited };
  }
  return submitReservationRequest(getDb(), input, { email: emailDeps() });
}
