import { describe, expect, it } from "vitest";

import {
  effectiveMapMode,
  isValidPin,
  OSM_TILE_URL,
  parsePinInput,
  pinOpenUrl,
  pinToInput,
} from "@/lib/map-pin";

/** Revizyon 2: harita yöntemleri ve iğne koordinatları (saf). */

const G = "https://www.google.com/maps?q=36.500000,29.123456&z=16&output=embed";
const P = { lat: 36.2655, lng: 29.4147 };

describe("iğne koordinatları", () => {
  it("nokta veya virgül; en fazla 6 ondalık; ikisi birlikte", () => {
    expect(parsePinInput("36,265512", " 29.4147 ")).toEqual({
      ok: true,
      pin: { lat: 36.265512, lng: 29.4147 },
    });
    expect(parsePinInput("", "")).toEqual({ ok: true, pin: null });
    expect(parsePinInput("36.2", "")).toEqual({ ok: false, error: "partial" });
    expect(parsePinInput("36.1234567", "29")).toEqual({ ok: false, error: "format" });
    expect(parsePinInput("1e2", "29")).toEqual({ ok: false, error: "format" });
    expect(parsePinInput("<b>", "29")).toEqual({ ok: false, error: "format" });
    expect(parsePinInput("90.5", "29")).toEqual({ ok: false, error: "range" });
    expect(parsePinInput("36", "-180.5")).toEqual({ ok: false, error: "range" });
    expect(parsePinInput("0", "0")).toEqual({ ok: false, error: "range" });
    expect(parsePinInput("-33.865143", "151.2099")).toMatchObject({ ok: true });
  });

  it("geçerlilik ve form gösterimi", () => {
    expect(isValidPin(36.26, 29.41)).toBe(true);
    expect(isValidPin(Number.NaN, 29)).toBe(false);
    expect(isValidPin(0, 0)).toBe(false);
    expect(pinToInput(36.2655)).toBe("36.2655");
    expect(pinToInput(null)).toBe("");
    expect(pinOpenUrl(P)).toBe(
      "https://www.google.com/maps/search/?api=1&query=36.265500,29.414700",
    );
    expect(OSM_TILE_URL).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  });
});

describe("harita yöntemi", () => {
  it("misafire gösterilen: seçili yöntem; eski kayıtta (NULL) Google adresi", () => {
    expect(effectiveMapMode("pin", G, P)).toBe("pin");
    expect(effectiveMapMode("google", G, P)).toBe("google");
    expect(effectiveMapMode("pin", G, null)).toBeNull();
    expect(effectiveMapMode("google", null, P)).toBeNull();
    expect(effectiveMapMode(null, G, null)).toBe("google");
    expect(effectiveMapMode(null, null, P)).toBeNull();
  });
});
