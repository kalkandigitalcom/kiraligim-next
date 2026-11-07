import { sql } from "drizzle-orm";

import type { SubscriptionStatus } from "@/db/schema/billing";
import type { Tx } from "@/db/tenant";

/**
 * İşletmenin paketi ve abonelik durumu. YALNIZ withTenant içinden çağrılır: satır RLS ile
 * bağlamdaki aktif işletmeye sınırlıdır; başka işletmenin aboneliği okunamaz.
 *
 * Geçerlilik kuralı veritabanındaki app_subscription_is_current() fonksiyonundadır (tek kaynak);
 * Aşama 2.4b'deki mülk limiti tetikleyicisi de aynı fonksiyonu kullanır. Buradaki karar yalnız
 * arayüz içindir; asıl engel veritabanındadır.
 */

/** Görünen durum: süresi dolan deneme/dönem "expired" olarak gösterilir. */
export type EffectiveStatus = "trialing" | "active" | "expired" | "canceled";

export type Entitlements = {
  planCode: string;
  planName: string;
  maxProperties: number;
  status: SubscriptionStatus;
  effectiveStatus: EffectiveStatus;
  isCurrent: boolean;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  /** Deneme sürerken kalan gün (yukarı yuvarlanır); diğer durumlarda null. */
  trialDaysLeft: number | null;
};

type Row = {
  plan_code: string;
  plan_name: string;
  max_properties: number;
  status: SubscriptionStatus;
  trial_ends_at: Date | string | null;
  current_period_end: Date | string | null;
  is_current: boolean;
  db_now: Date | string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const toDate = (v: Date | string | null) => (v === null ? null : new Date(v));

export function toEntitlements(row: Row): Entitlements {
  const trialEndsAt = toDate(row.trial_ends_at);
  const now = new Date(row.db_now);
  const effectiveStatus: EffectiveStatus =
    (row.status === "trialing" || row.status === "active") && !row.is_current
      ? "expired"
      : row.status;
  const trialDaysLeft =
    row.status === "trialing" && row.is_current && trialEndsAt
      ? Math.max(1, Math.ceil((trialEndsAt.getTime() - now.getTime()) / DAY_MS))
      : null;
  return {
    planCode: row.plan_code,
    planName: row.plan_name,
    maxProperties: row.max_properties,
    status: row.status,
    effectiveStatus,
    isCurrent: row.is_current,
    trialEndsAt,
    currentPeriodEnd: toDate(row.current_period_end),
    trialDaysLeft,
  };
}

export async function getEntitlements(tx: Tx): Promise<Entitlements | null> {
  const res = await tx.execute<Row>(sql`
    select p.code as plan_code, p.name as plan_name, p.max_properties,
           s.status, s.trial_ends_at, s.current_period_end,
           app_subscription_is_current(s.status, s.trial_ends_at, s.current_period_end) as is_current,
           now() as db_now
      from workspace_subscriptions s
      join plans p on p.id = s.plan_id
     where s.workspace_id = app_current_workspace_id()`);
  const row = res.rows[0];
  return row ? toEntitlements(row) : null;
}

export type PropertyAllowance =
  | { allowed: true; used: number; limit: number }
  | {
      allowed: false;
      reason: "no_subscription" | "subscription_inactive" | "limit_reached";
      used: number;
      limit: number;
    };

/**
 * Yeni mülk eklenebilir mi? (Arayüz ve servis ön denetimi; asıl engel 2.4b'de veritabanında.)
 * Abonelik geçerli değilse mevcut mülkler düzenlenebilir ama yeni mülk eklenemez.
 */
export function evaluatePropertyAllowance(
  entitlements: Entitlements | null,
  used: number,
): PropertyAllowance {
  if (!entitlements) return { allowed: false, reason: "no_subscription", used, limit: 0 };
  const limit = entitlements.maxProperties;
  if (!entitlements.isCurrent) {
    return { allowed: false, reason: "subscription_inactive", used, limit };
  }
  if (used >= limit) return { allowed: false, reason: "limit_reached", used, limit };
  return { allowed: true, used, limit };
}

export const ALLOWANCE_MESSAGES: Record<
  Exclude<PropertyAllowance, { allowed: true }>["reason"],
  string
> = {
  no_subscription: "İşletmenizin aktif bir paketi bulunmuyor.",
  subscription_inactive:
    "Deneme süreniz sona erdi. Mevcut mülklerinizi görüntüleyip düzenleyebilirsiniz; yeni mülk ekleyemezsiniz.",
  limit_reached: "Paketinizin mülk sınırına ulaştınız.",
};
