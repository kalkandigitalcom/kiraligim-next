import { describe, expect, it } from "vitest";

import drizzleConfig from "../../drizzle.config";
import { DB_CASING } from "@/db/casing";

describe("Drizzle adlandırması", () => {
  it("drizzle-kit ve çalışma zamanı aynı casing değerini kullanır", () => {
    expect(DB_CASING).toBe("snake_case");
    expect((drizzleConfig as { casing?: string }).casing).toBe(DB_CASING);
  });
});
