import { describe, expect, it } from "vitest";

import { activeNavHref, NAV_GROUPS } from "@/app/host/(panel)/_components/nav-config";

/** Panel kenar çubuğu menüsü (Aşama 1): öğeler ve etkin bağlantı eşleşmesi. */
describe("panel menüsü", () => {
  it("ana bölümler, mevcut adreslerle", () => {
    expect(NAV_GROUPS.flatMap((g) => g.items.map((i) => [i.label, i.href]))).toEqual([
      ["Genel Bakış", "/panel"],
      ["Mülkler", "/villalar"],
      ["Rezervasyonlar", "/rezervasyonlar"],
      ["Takvim", "/takvim"],
    ]);
  });

  it("alt sayfalar üst bölümü etkin gösterir", () => {
    expect(activeNavHref("/panel")).toBe("/panel");
    expect(activeNavHref("/villalar")).toBe("/villalar");
    expect(activeNavHref("/villalar/yeni")).toBe("/villalar");
    expect(activeNavHref("/villalar/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/fiyatlar")).toBe(
      "/villalar",
    );
    expect(activeNavHref("/rezervasyonlar/yeni")).toBe("/rezervasyonlar");
    expect(activeNavHref("/takvim")).toBe("/takvim");
  });

  it("benzer önekli ya da menü dışı adresler etkin değildir", () => {
    expect(activeNavHref("/villalarx")).toBeNull();
    expect(activeNavHref("/panelim")).toBeNull();
    expect(activeNavHref("/isletmeler")).toBeNull();
    // İşletme panelinde WhatsApp modülü yok (eski adres ana panele yönlenir).
    expect(activeNavHref("/whatsapp")).toBeNull();
    expect(activeNavHref("/whatsapp/oneriler")).toBeNull();
    expect(activeNavHref("/")).toBeNull();
  });
});
