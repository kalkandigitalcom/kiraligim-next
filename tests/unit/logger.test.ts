import { describe, expect, it } from "vitest";

import { createLogger, redact } from "@/lib/logger";

describe("logger", () => {
  it("tek satır JSON yazar", () => {
    const lines: string[] = [];
    createLogger({ service: "t" }, (l) => lines.push(l)).warn("deneme", { a: 1 });
    const entry = JSON.parse(lines[0] ?? "{}");
    expect(entry).toMatchObject({ level: "warn", msg: "deneme", service: "t", a: 1 });
  });

  it("hassas alanları ve URL parolalarını maskeler", () => {
    const out = redact({
      password: "x",
      apiKey: "y",
      nested: { BETTER_AUTH_SECRET: "z" },
      url: "postgres://app_user:cokgizli@db:5432/lodging_dev",
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/cokgizli|"x"|"y"|"z"/);
    expect(out.url).toBe("postgres://app_user:[gizli]@db:5432/lodging_dev");
  });
});
