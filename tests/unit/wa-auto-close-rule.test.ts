import { describe, expect, it } from "vitest";

import { parseCalendarMessage } from "@/lib/wa-calendar-parse";
import { autoCloseCandidate } from "@/server/whatsapp/calendar/auto-close-rule";
import { type BusyRow, buildStoreItem, type StoreItem } from "@/server/whatsapp/calendar/proposal";
import { resolveProposal, type ResolveContext } from "@/server/whatsapp/calendar/resolve";

/**
 * A2e: hangi öğe panel onayı beklemeden blok olabilir? Kural dardır; şüphede öneri panelde bekler.
 */
const TODAY = "2026-11-10";
const WS = "ws-1";
const ctx: ResolveContext = {
  workspaceId: WS,
  villas: [
    { id: "testo", workspaceId: WS, name: "Villa Testo" },
    { id: "asya", workspaceId: WS, name: "Villa Asya" },
  ],
  groupPropertyId: "testo",
};

function items(
  text: string,
  o: { busy?: BusyRow[]; role?: "owner" | "manager" | "staff" | null; group?: string | null } = {},
): StoreItem[] {
  const c = { ...ctx, groupPropertyId: o.group === undefined ? "testo" : o.group };
  return parseCalendarMessage(text, TODAY).items.map((item, i) =>
    buildStoreItem({
      item,
      itemNo: i,
      villa: resolveProposal(item, c),
      busy: o.busy ?? [],
      senderRole: o.role === undefined ? "owner" : o.role,
    }),
  );
}
const cand = (
  text: string,
  o: { busy?: BusyRow[]; role?: "owner" | "manager" | "staff" | null; group?: string | null } = {},
) =>
  autoCloseCandidate(items(text, o), {
    senderRole: o.role === undefined ? "owner" : o.role,
    groupPropertyId: o.group === undefined ? "testo" : o.group,
  });

describe("otomatik kapatma kuralı", () => {
  it.each([
    ["Villa Testo 10–15 Haziran kapatalım.", "2027-06-10", "2027-06-15"],
    [
      "10 Haziran giriş, 15 Haziran çıkış tarihine kadar villayı kapat.",
      "2027-06-10",
      "2027-06-15",
    ],
    ["Villa Testo 10-15 Haziran kapalı", "2027-06-10", "2027-06-15"],
    ["10-15 Haziran kapatalım", "2027-06-10", "2027-06-15"],
  ])("sahibin açık talimatı uygun: %s", (text, checkIn, checkOut) => {
    expect(cand(text)).toMatchObject({
      action: "close",
      property_id: "testo",
      check_in: checkIn,
      check_out: checkOut,
    });
  });

  it.each([
    ["yönetici", { role: "manager" as const }],
    ["personel", { role: "staff" as const }],
    ["doğrulanmamış gönderen", { role: null }],
    ["grubun villası yok", { group: null }],
  ])("%s → panel onayı", (_label, o) => {
    expect(cand("Villa Testo 10–15 Haziran kapatalım.", o)).toBeNull();
  });

  it.each([
    "Villa Testo 10 Haziran kapatalım", // tek tarih
    "Villa Testo kapatalım", // tarih yok
    "Villa Testo 10–15 Haziran kapatalım mı?", // soru
    "Villa Testo 10 Haziran giriş, 15 Haziran çıkış, 4 kişi rezervasyon.", // rezervasyon
    "Villa Testo 10-15 Haziran açıldı", // açma
    "Villa Testo 10-15 Haziran iptal", // iptal
    "Villa Testo 10-15 Haziran kapalı, 1-3 Temmuz kapalı", // birden çok öğe
    "Villa Testo 10 Haziran giriş 15 Haziran çıkış dolu", // durum bildirimi + giriş/çıkış: belirsiz
  ])("uygun değil: %s", (text) => {
    expect(cand(text)).toBeNull();
  });

  it("çakışma varsa uygun değil", () => {
    const busy: BusyRow[] = [
      {
        kind: "reservation",
        recordId: "r1",
        checkIn: "2027-06-12",
        checkOut: "2027-06-14",
        status: "confirmed",
      },
    ];
    expect(cand("Villa Testo 10–15 Haziran kapatalım.", { busy })).toBeNull();
  });
});

describe("grup eşleştirmesi kesin kaynak (production senaryosu)", () => {
  // Grup adı "villa testo", bağlı villa "Villa In Love" (işletmenin tek villası değil: Asya da var).
  const prod: ResolveContext = {
    workspaceId: WS,
    villas: [
      { id: "inlove", workspaceId: WS, name: "Villa In Love" },
      { id: "asya", workspaceId: WS, name: "Villa Asya" },
    ],
    groupPropertyId: "inlove",
  };
  const candFor = (text: string, role: "owner" | "manager" | "staff" | null = "owner") =>
    autoCloseCandidate(
      parseCalendarMessage(text, TODAY).items.map((item, i) =>
        buildStoreItem({
          item,
          itemNo: i,
          villa: resolveProposal(item, prod),
          busy: [],
          senderRole: role,
        }),
      ),
      { senderRole: role, groupPropertyId: prod.groupPropertyId },
    );

  it.each([
    ["ad gerçek villa adıyla aynı", "Villa In Love 10–15 Haziran kapatalım.", []],
    ["ad farklı (grubun adı)", "Villa Testo 10–15 Haziran kapatalım.", ["villa_name_mismatch"]],
    ["ad hiç yok", "10–15 Haziran kapatalım.", ["villa_missing"]],
    ["başka villanın adı", "Villa Asya 10–15 Haziran kapatalım.", ["villa_name_mismatch"]],
  ])("%s → grubun villası bloklanır", (_label, text, extra) => {
    const c = candFor(text);
    expect(c).toMatchObject({ property_id: "inlove", action: "close", review_reasons: [] });
    expect(c!.flags.filter((f) => f !== "year_inferred")).toEqual(extra);
  });

  it("grup eşleştirmesi yoksa (villasız grup) aday yok", () => {
    const items = parseCalendarMessage("Villa In Love 10–15 Haziran kapatalım.", TODAY).items;
    const store = items.map((item, i) =>
      buildStoreItem({
        item,
        itemNo: i,
        villa: resolveProposal(item, { ...prod, groupPropertyId: null }),
        busy: [],
        senderRole: "owner",
      }),
    );
    expect(autoCloseCandidate(store, { senderRole: "owner", groupPropertyId: null })).toBeNull();
  });

  it.each(["manager", "staff", null] as const)("yetkisiz gönderen (%s) → aday yok", (role) => {
    expect(candFor("Villa Testo 10–15 Haziran kapatalım.", role)).toBeNull();
  });
});

describe("ayrıştırıcı v3: giriş/çıkış + kapat", () => {
  it("açık 'kapat' talimatıyla giriş/çıkış kapatmadır", () => {
    const [it0] = parseCalendarMessage(
      "10 Haziran giriş, 15 Haziran çıkış tarihine kadar villayı kapat.",
      TODAY,
    ).items;
    expect(it0).toMatchObject({ action: "close", checkIn: "2027-06-10", checkOut: "2027-06-15" });
  });
  it("'kapalı/dolu' + giriş/çıkış belirsiz kalır; yalnız giriş/çıkış rezervasyondur", () => {
    expect(
      parseCalendarMessage("10 Haziran giriş 15 Haziran çıkış dolu", TODAY).items[0]!.action,
    ).toBeNull();
    expect(
      parseCalendarMessage("10 Haziran giriş 15 Haziran çıkış kapalı", TODAY).items[0]!.action,
    ).toBeNull();
    expect(parseCalendarMessage("10 Haziran giriş 15 Haziran çıkış", TODAY).items[0]!.action).toBe(
      "reserve",
    );
  });
});
