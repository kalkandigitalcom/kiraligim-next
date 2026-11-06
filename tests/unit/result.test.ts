import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { forbidden, GENERIC_ERROR_MESSAGE, validationError } from "@/lib/errors";
import { runAction, zodFieldErrors } from "@/lib/result";

vi.spyOn(process.stdout, "write").mockImplementation(() => true);

describe("runAction", () => {
  it("başarılı sonucu sarar", async () => {
    await expect(runAction("t", async () => 42)).resolves.toEqual({ ok: true, data: 42 });
  });

  it("gösterilebilir hatanın mesajını döndürür", async () => {
    const res = await runAction("t", async () => {
      throw forbidden();
    });
    expect(res).toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "Bu işlem için yetkiniz yok." },
    });
  });

  it("beklenmeyen hatanın ayrıntısını gizler", async () => {
    const res = await runAction("t", async () => {
      throw new Error("SQL: select * from secrets");
    });
    expect(res).toEqual({ ok: false, error: { code: "INTERNAL", message: GENERIC_ERROR_MESSAGE } });
  });

  it("alan hatalarını taşır", async () => {
    const parsed = z.object({ email: z.email() }).safeParse({ email: "x" });
    if (parsed.success) throw new Error("beklenmedi");
    const res = await runAction("t", async () => {
      throw validationError(zodFieldErrors(parsed.error));
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.fieldErrors?.email?.length).toBe(1);
  });
});
