import { describe, expect, it } from "vitest";

import {
  OPTION_END_REASON_LIST,
  OPTION_END_REASONS,
  OPTION_EXPIRY_SOURCES,
  OPTION_EXTEND_LIMITS,
  OPTION_MIN_LEAD_MINUTES,
  OPTION_OPERATION_FINAL,
  OPTION_OPERATION_KINDS,
  OPTION_OPERATION_MODES,
  OPTION_OPERATION_REASONS,
  OPTION_OPERATION_STATUSES,
  OPTION_SETTINGS_LIMITS,
  OPTION_STATUS_BADGES,
  OPTION_SYSTEM_DEFAULT_MINUTES,
  OPTION_WHATSAPP_CANCEL_REASONS,
  SHADOW_REASONS,
} from "@/lib/option-meta";

describe("opsiyon sabitleri (Aşama 3a kararları)", () => {
  it("iptal nedenleri onaylanan adlar; kesinleşme ve süre dolumu adları aynı", () => {
    expect(OPTION_END_REASONS.cancelled).toEqual([
      "customer_declined",
      "owner_cancelled",
      "panel_cancel",
      // Faz B (0077): WhatsApp'tan tarih değişikliği (eski opsiyon kapanır, yenisi ona bağlanır).
      "date_changed",
    ]);
    expect(OPTION_END_REASONS.converted).toEqual(["payment_received", "confirmed_in_panel"]);
    expect(OPTION_END_REASONS.expired).toEqual(["expired"]);
    expect(OPTION_END_REASON_LIST).not.toContain("customer_withdrew");
    // panel_cancel yalnız Super Admin'den; WhatsApp'tan gelemez.
    expect(OPTION_WHATSAPP_CANCEL_REASONS).toEqual(["customer_declined", "owner_cancelled"]);
  });

  it("Faz B: işlem türleri + extend / reschedule; uzatma en az 1 saat, ömür en çok 14 gün", () => {
    expect(OPTION_OPERATION_KINDS).toEqual(["create", "cancel", "convert", "extend", "reschedule"]);
    expect(OPTION_EXTEND_LIMITS).toEqual({ minMinutes: 60, maxLifetimeMinutes: 20160 });
    for (const r of [
      "extend_after_check_in",
      "extend_over_max",
      "new_range_missing",
      "same_range",
      "option_without_expiry",
      "duration_missing",
    ]) {
      expect(OPTION_OPERATION_REASONS).toContain(r);
    }
  });

  it("süre ayarları 1 saat – 14 gün (dakika); hazır liste yok", () => {
    expect(OPTION_SETTINGS_LIMITS.minMinutes).toBe(60);
    expect(OPTION_SETTINGS_LIMITS.maxMinutes).toBe(20160);
  });

  it("Faz A (0075): sistem varsayılanı 24 saat, sınırlar içinde; yeni kaynak ve mod", () => {
    expect(OPTION_SYSTEM_DEFAULT_MINUTES).toBe(1440);
    expect(OPTION_SYSTEM_DEFAULT_MINUTES).toBeGreaterThanOrEqual(OPTION_SETTINGS_LIMITS.minMinutes);
    expect(OPTION_SYSTEM_DEFAULT_MINUTES).toBeLessThanOrEqual(OPTION_SETTINGS_LIMITS.maxMinutes);
    expect(OPTION_MIN_LEAD_MINUTES).toBe(60);
    expect(OPTION_EXPIRY_SOURCES).toEqual([
      "message",
      "workspace_default",
      "manual",
      "system_default",
    ]);
    expect(OPTION_OPERATION_MODES).toEqual(["auto", "needs_approval", "clarify"]);
    expect(OPTION_OPERATION_REASONS).toContain("check_in_too_close");
  });

  it("işlem durumları ve nedenleri: gölge nedenlerini kapsar, son durumlar durum listesinde", () => {
    for (const r of SHADOW_REASONS) expect(OPTION_OPERATION_REASONS).toContain(r);
    for (const f of OPTION_OPERATION_FINAL) expect(OPTION_OPERATION_STATUSES).toContain(f);
    for (const r of OPTION_OPERATION_REASONS) expect(r).toMatch(/^[a-z_]{1,40}$/);
  });

  it("durum rozetleri yalnız panel içindir: açık 🟡, kesinleşen ✅, iptal / süresi dolan ❌", () => {
    expect(OPTION_STATUS_BADGES).toEqual({
      open: "\u{1F7E1}",
      converted: "✅",
      cancelled: "❌",
      expired: "❌",
    });
  });
});
