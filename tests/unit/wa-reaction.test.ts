import { describe, expect, it } from "vitest";

import { parseCalendarMessage } from "@/lib/wa-calendar-parse";
import { WA_REACTION_EMOJI } from "@/lib/whatsapp-meta";
import { type BusyRow, buildStoreItem, type StoreItem } from "@/server/whatsapp/calendar/proposal";
import { decideReaction } from "@/server/whatsapp/calendar/reaction";
import { resolveProposal, type ResolveContext } from "@/server/whatsapp/calendar/resolve";

/** A2f / B aşaması: merkezi tepki kararı (saf). ☑️ (submitted) hiçbir zaman seçilmez. */
const TODAY = "2026-11-10";
const WS = "ws-1";
const ctx: ResolveContext = {
  workspaceId: WS,
  villas: [{ id: "inlove", workspaceId: WS, name: "Villa In Love" }],
  groupPropertyId: "inlove",
};
type Role = "owner" | "manager" | "staff" | "participant" | null;
const items = (text: string, o: { busy?: BusyRow[]; role?: Role; group?: string | null } = {}) =>
  parseCalendarMessage(text, TODAY).items.map((item, i) =>
    buildStoreItem({
      item,
      itemNo: i,
      villa: resolveProposal(item, {
        ...ctx,
        groupPropertyId: o.group === undefined ? "inlove" : o.group,
      }),
      busy: o.busy ?? [],
      senderRole: o.role === undefined ? "owner" : o.role,
    }),
  );
const decide = (
  text: string,
  o: { busy?: BusyRow[]; role?: Role; group?: string | null; auto?: "applied" | "failed" } = {},
) => {
  const its: StoreItem[] = items(text, o);
  return decideReaction({
    senderRole: o.role === undefined ? "owner" : o.role,
    items: its,
    stored: its.length,
    ...(o.auto ? { autoClose: o.auto } : {}),
  });
};
const BUSY: BusyRow[] = [
  {
    kind: "reservation",
    recordId: "r1",
    checkIn: "2027-06-11",
    checkOut: "2027-06-13",
    status: "confirmed",
  },
];

describe("merkezi tepki kararı", () => {
  it("emoji eşlemesi sabit: ✅ ☑️ ⚠️", () => {
    expect(WA_REACTION_EMOJI).toEqual({ done: "✅", submitted: "☑️", warning: "⚠️" });
  });

  it("otomatik blok başarılı → ✅ (yalnız servis 'applied' döndürünce)", () => {
    expect(decide("Villa Testo 10–15 Haziran kapatalım.", { auto: "applied" })).toBe("done");
    // Servis çağrılmadıysa (ör. kapatma ama otomatik değil) yeşil tik YOK; anlaşıldı ama uygulanmadı.
    expect(decide("Villa Testo 10–15 Haziran kapatalım.")).toBe("warning");
  });

  it("otomatik blok denendi ama uygulanamadı → ⚠️", () => {
    expect(decide("Villa Testo 10–15 Haziran kapatalım.", { auto: "failed" })).toBe("warning");
  });

  it("rezervasyon talimatı (otomatik oluşturma kapalı) → ⚠️ (asla ✅ veya ☑️ değil)", () => {
    const text = "Villa In Love 10 Haziran giriş, 15 Haziran çıkış, 4 kişi rezervasyon.";
    expect(decide(text)).toBe("warning");
    expect(decide(text, { role: "participant" })).toBe("warning");
  });

  it("tarih belirsiz / eksik → ⚠️", () => {
    expect(decide("Villa In Love 10 Haziran kapatalım")).toBe("warning");
    expect(decide("Villa In Love kapatalım")).toBe("warning");
    expect(decide("Villa In Love 10 Haziran giriş rezervasyon")).toBe("warning");
  });

  it("anlaşılamayan (çelişen eylem) → ⚠️", () => {
    expect(decide("Villa In Love 10-15 Haziran kapalı ama rezervasyon da olabilir")).toBe(
      "warning",
    );
  });

  it("takvim çakışması → ⚠️", () => {
    expect(decide("Villa In Love 10–15 Haziran kapatalım.", { busy: BUSY })).toBe("warning");
  });

  it("villa eşleştirmesi yok (villasız grup, bilinmeyen ad) → ⚠️", () => {
    expect(decide("Villa Begonya 10–15 Haziran kapatalım.", { group: null })).toBe("warning");
  });

  it("B aşaması: sahip olmayan grup katılımcıları da tepki alır", () => {
    for (const role of ["manager", "staff", "participant"] as const) {
      expect(decide("Villa In Love 10–15 Haziran kapatalım.", { role, auto: "applied" })).toBe(
        "done",
      );
      expect(decide("Villa In Love 10–15 Haziran kapatalım.", { role, auto: "failed" })).toBe(
        "warning",
      );
    }
  });

  it("yetkisiz gönderen (engelli / numarası belirlenemeyen) → tepki yok", () => {
    expect(decide("Villa In Love 10–15 Haziran kapatalım.", { role: null })).toBeNull();
    expect(
      decide("Villa In Love 10–15 Haziran kapatalım.", { role: null, auto: "applied" }),
    ).toBeNull();
  });

  it("takvimle ilgisiz sohbet ve soru → tepki yok", () => {
    expect(decide("Günaydın, havuzcu yarın 10'da gelecek")).toBeNull();
    expect(decide("Villa In Love 10–15 Haziran müsait mi?")).toBeNull();
    expect(decideReaction({ senderRole: "owner", items: [], stored: 0 })).toBeNull();
  });

  it("öneri kaydedilmediyse (stored = 0) tepki yok", () => {
    const its = items("Villa In Love 10–15 Haziran kapatalım.");
    expect(decideReaction({ senderRole: "owner", items: its, stored: 0 })).toBeNull();
  });

  it("açma uygulanmadıysa / iptal (desteklenmiyor) → ⚠️, ☑️ değil", () => {
    expect(decide("Villa In Love 10-15 Haziran açıldı")).toBe("warning");
    expect(decide("Villa In Love 10-15 Haziran iptal")).toBe("warning");
  });

  it("birden çok öğe: biri sorunluysa ⚠️", () => {
    expect(decide("Villa In Love 10-15 Haziran kapalı, 20 Temmuz kapalı")).toBe("warning");
  });

  it("Aşama 2: açma — bloklar kaldırıldıysa ✅, kaldırılamadıysa ⚠️", () => {
    expect(decide("Villa In Love 10-15 Haziran açalım", { auto: "applied" })).toBe("done");
    expect(decide("Villa In Love 10-15 Haziran açalım", { auto: "failed" })).toBe("warning");
    expect(decide("Villa In Love 15 Haziran açalım")).toBe("warning"); // tek tarih: belirsiz
  });

  it("☑️ (submitted) hiçbir girdide seçilmez", () => {
    const texts = [
      "Villa In Love 10–15 Haziran kapatalım.",
      "Villa In Love 10 Haziran giriş, 15 Haziran çıkış, 4 kişi rezervasyon.",
      "Villa In Love 10-15 Haziran açıldı",
      "Villa In Love 10 Haziran kapatalım",
    ];
    for (const t of texts)
      for (const role of ["owner", "manager", "staff", "participant", null] as const)
        for (const auto of [undefined, "applied", "failed"] as const)
          expect(decide(t, { role, ...(auto ? { auto } : {}) })).not.toBe("submitted");
  });
});
