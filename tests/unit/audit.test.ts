import { describe, expect, it } from "vitest";

import { type AuditEntry, validateAuditEntry } from "@/server/audit/record";

const bad = (entry: unknown) => () => validateAuditEntry(entry as AuditEntry);

describe("denetim metadata doğrulaması", () => {
  it("tanımlı işlem ve şemaya uygun metadata kabul edilir", () => {
    expect(
      validateAuditEntry({
        action: "workspace.member_role_changed",
        metadata: { from: "staff", to: "manager" },
      }),
    ).toEqual({ from: "staff", to: "manager" });
  });

  it("bilinmeyen işlem reddedilir", () => {
    expect(bad({ action: "user.hacked", metadata: {} })).toThrow(/Bilinmeyen/);
  });

  it.each([
    ["password", { password: "x" }],
    ["token", { slug: "a", token: "x" }],
    ["email", { email: "a@b.com" }],
    ["phone", { phone: "555" }],
    ["tc_kimlik", { tcKimlik: "1" }],
    ["ip_address", { ip_address: "1.2.3.4" }],
    ["user_agent", { userAgent: "x" }],
    ["ad", { ad: "Ayşe" }],
    ["full_name", { fullName: "Ayşe Y" }],
    ["iç içe", { fields: [{ apiKey: "x" }] }],
  ])("hassas anahtar reddedilir: %s", (_n, metadata) => {
    expect(bad({ action: "workspace.created", metadata })).toThrow(/hassas alan/);
  });

  it("şemada olmayan ek alan reddedilir (strict)", () => {
    expect(bad({ action: "workspace.created", metadata: { slug: "a", note: "x" } })).toThrow(
      /geçersiz/,
    );
  });

  it("geçersiz rol değeri reddedilir", () => {
    expect(bad({ action: "workspace.member_added", metadata: { role: "superadmin" } })).toThrow(
      /geçersiz/,
    );
  });
});
