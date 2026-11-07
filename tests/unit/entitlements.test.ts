import { describe, expect, it } from "vitest";

import {
  ALLOWANCE_MESSAGES,
  evaluatePropertyAllowance,
  toEntitlements,
} from "@/server/billing/entitlements";

const now = new Date("2026-11-07T12:00:00Z");
const base = {
  plan_code: "baslangic",
  plan_name: "Başlangıç",
  max_properties: 1,
  current_period_end: null,
  db_now: now,
};
const days = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

describe("toEntitlements", () => {
  it("süren deneme: kalan gün yukarı yuvarlanır, en az 1", () => {
    const e = toEntitlements({
      ...base,
      status: "trialing",
      trial_ends_at: days(13.2),
      is_current: true,
    });
    expect(e).toMatchObject({ effectiveStatus: "trialing", trialDaysLeft: 14, isCurrent: true });
    expect(
      toEntitlements({
        ...base,
        status: "trialing",
        trial_ends_at: new Date(now.getTime() + 60_000),
        is_current: true,
      }).trialDaysLeft,
    ).toBe(1);
  });

  it("biten deneme ve dönem 'expired' görünür", () => {
    expect(
      toEntitlements({ ...base, status: "trialing", trial_ends_at: days(-1), is_current: false }),
    ).toMatchObject({ effectiveStatus: "expired", trialDaysLeft: null });
    expect(
      toEntitlements({ ...base, status: "active", trial_ends_at: null, is_current: false }),
    ).toMatchObject({ effectiveStatus: "expired" });
  });

  it("iptal ve aktif durumlar korunur; tarih metinleri Date'e çevrilir", () => {
    const e = toEntitlements({
      ...base,
      status: "active",
      trial_ends_at: "2026-11-01T00:00:00Z",
      is_current: true,
    });
    expect(e.effectiveStatus).toBe("active");
    expect(e.trialEndsAt).toBeInstanceOf(Date);
    expect(
      toEntitlements({ ...base, status: "canceled", trial_ends_at: null, is_current: false })
        .effectiveStatus,
    ).toBe("canceled");
  });
});

describe("evaluatePropertyAllowance", () => {
  const current = toEntitlements({
    ...base,
    status: "trialing",
    trial_ends_at: days(5),
    is_current: true,
  });
  const expired = toEntitlements({
    ...base,
    status: "trialing",
    trial_ends_at: days(-5),
    is_current: false,
  });

  it("limit altında izin verir, limitte durdurur", () => {
    expect(evaluatePropertyAllowance(current, 0)).toEqual({ allowed: true, used: 0, limit: 1 });
    expect(evaluatePropertyAllowance(current, 1)).toEqual({
      allowed: false,
      reason: "limit_reached",
      used: 1,
      limit: 1,
    });
  });

  it("süresi dolan abonelikte limit altı olsa da yeni mülk yok", () => {
    expect(evaluatePropertyAllowance(expired, 0)).toMatchObject({
      allowed: false,
      reason: "subscription_inactive",
    });
  });

  it("abonelik yoksa izin vermez; her neden için Türkçe mesaj var", () => {
    expect(evaluatePropertyAllowance(null, 0)).toMatchObject({ reason: "no_subscription" });
    for (const m of Object.values(ALLOWANCE_MESSAGES)) expect(m.length).toBeGreaterThan(10);
  });
});
