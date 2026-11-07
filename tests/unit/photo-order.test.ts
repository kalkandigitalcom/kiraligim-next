import { describe, expect, it } from "vitest";

import { isPermutationOf, moveId, sameOrder } from "@/lib/photo-order";

describe("fotoğraf sırası yardımcıları", () => {
  const ids = ["a", "b", "c", "d"];

  it("moveId: öğeyi hedef konuma taşır, diğerlerinin sırası korunur", () => {
    expect(moveId(ids, "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveId(ids, "a", 3)).toEqual(["b", "c", "d", "a"]);
    expect(moveId(ids, "b", 2)).toEqual(["a", "c", "b", "d"]);
    expect(moveId(ids, "c", 1)).toEqual(["a", "c", "b", "d"]);
  });

  it("moveId: aynı yer, sınır dışı hedef ve bilinmeyen kimlik güvenli", () => {
    expect(moveId(ids, "b", 1)).toEqual(ids);
    expect(moveId(ids, "b", 99)).toEqual(["a", "c", "d", "b"]);
    expect(moveId(ids, "c", -5)).toEqual(["c", "a", "b", "d"]);
    expect(moveId(ids, "x", 0)).toEqual(ids);
    const copy = moveId(ids, "a", 2);
    expect(ids).toEqual(["a", "b", "c", "d"]); // girdi değişmez
    expect(copy).not.toBe(ids);
  });

  it("sameOrder ve isPermutationOf", () => {
    expect(sameOrder(ids, ["a", "b", "c", "d"])).toBe(true);
    expect(sameOrder(ids, ["a", "b", "d", "c"])).toBe(false);
    expect(isPermutationOf(["d", "c", "b", "a"], ids)).toBe(true);
    expect(isPermutationOf(["a", "b", "c"], ids)).toBe(false);
    expect(isPermutationOf(["a", "a", "b", "c"], ids)).toBe(false);
    expect(isPermutationOf(["a", "b", "c", "x"], ids)).toBe(false);
  });
});
