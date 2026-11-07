import { describe, expect, it } from "vitest";

import { reservationSearchInput } from "@/server/reservations/search";

/** Misafir adı araması: terim POST gövdesiyle gelir; yalnız şekil ve sınırlar doğrulanır. */
describe("rezervasyon arama girdisi", () => {
  const ok = { view: "upcoming", query: "  Ayşe ", page: 1 };

  it("geçerli girdi: terim kırpılır, isteğe bağlı tür ve mülk", () => {
    expect(reservationSearchInput.parse(ok)).toEqual({ view: "upcoming", query: "Ayşe", page: 1 });
    expect(
      reservationSearchInput.parse({
        ...ok,
        kind: "block",
        propertyId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
        page: 3,
      }),
    ).toMatchObject({ kind: "block", page: 3 });
  });

  it.each([
    ["boş terim", { ...ok, query: "   " }],
    ["çok uzun terim", { ...ok, query: "a".repeat(121) }],
    ["geçersiz görünüm", { ...ok, view: "all" }],
    ["geçersiz tür", { ...ok, kind: "x" }],
    ["geçersiz mülk kimliği", { ...ok, propertyId: "../x" }],
    ["sayfa 0", { ...ok, page: 0 }],
    ["sayfa sınırı", { ...ok, page: 501 }],
    ["ondalık sayfa", { ...ok, page: 1.5 }],
    ["metin sayfa", { ...ok, page: "2" }],
    ["bilinmeyen alan", { ...ok, workspaceId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" }],
    ["nesne değil", "Ayşe"],
  ])("reddedilir: %s", (_label, input) => {
    expect(reservationSearchInput.safeParse(input).success).toBe(false);
  });
});
