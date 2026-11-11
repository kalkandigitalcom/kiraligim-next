import { describe, expect, it } from "vitest";

import { parseCalendarMessage } from "@/lib/wa-calendar-parse";
import { autoCloseCandidate, autoOpenCandidate } from "@/server/whatsapp/calendar/auto-close-rule";
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
  o: {
    busy?: BusyRow[];
    role?: "owner" | "manager" | "staff" | "participant" | null;
    group?: string | null;
  } = {},
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
  o: {
    busy?: BusyRow[];
    role?: "owner" | "manager" | "staff" | "participant" | null;
    group?: string | null;
  } = {},
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

  // B aşaması: bağlı grubun engellenmemiş HER katılımcısı yetkilidir (sahip olması gerekmez).
  it.each(["manager", "staff", "participant"] as const)(
    "sahip olmayan grup katılımcısı (%s) da uygun",
    (role) => {
      expect(cand("Villa Testo 10–15 Haziran kapatalım.", { role })).toMatchObject({
        action: "close",
        property_id: "testo",
        check_in: "2027-06-10",
        check_out: "2027-06-15",
        review_reasons: [],
      });
    },
  );

  it.each([
    ["yetkisiz gönderen (engelli / numarası belirlenemeyen)", { role: null }],
    ["grubun villası yok", { group: null }],
  ])("%s → aday yok", (_label, o) => {
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
  const candFor = (
    text: string,
    role: "owner" | "manager" | "staff" | "participant" | null = "owner",
  ) =>
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

  it.each(["manager", "staff", "participant"] as const)(
    "grup katılımcısı (%s) → grubun villası bloklanır",
    (role) => {
      expect(candFor("Villa Testo 10–15 Haziran kapatalım.", role)).toMatchObject({
        property_id: "inlove",
        action: "close",
      });
    },
  );

  it("yetkisiz gönderen (null) → aday yok", () => {
    expect(candFor("Villa Testo 10–15 Haziran kapatalım.", null)).toBeNull();
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

describe("Aşama 2: otomatik açma kuralı", () => {
  const open = (
    text: string,
    o: { busy?: BusyRow[]; role?: "owner" | "participant" | null; group?: string | null } = {},
  ) =>
    autoOpenCandidate(items(text, o), {
      senderRole: o.role === undefined ? "participant" : o.role,
      groupPropertyId: o.group === undefined ? "testo" : o.group,
    });
  const BLOCK: BusyRow[] = [
    {
      kind: "block",
      recordId: "b1",
      checkIn: "2026-12-10",
      checkOut: "2026-12-15",
      status: "confirmed",
    },
  ];

  it.each([
    ["10-15 Aralık tarihlerini açalım.", "2026-12-10", "2026-12-15"],
    ["20-25 Aralık arasını müsait yapalım.", "2026-12-20", "2026-12-25"],
    ["Daha önce kapattığımız 5-10 Ocak tarihlerini serbest bırakalım.", "2027-01-05", "2027-01-10"],
    ["Villa artık 15-20 Aralık arasında müsait.", "2026-12-15", "2026-12-20"],
    ["Villa Testo 10-15 Aralık kapalı olan tarihleri açalım", "2026-12-10", "2026-12-15"],
  ])("açık açma talimatı uygun: %s", (text, checkIn, checkOut) => {
    expect(open(text, { busy: BLOCK })).toMatchObject({
      action: "open",
      property_id: "testo",
      check_in: checkIn,
      check_out: checkOut,
      review_reasons: [],
    });
  });

  it.each([
    "15 Aralık açalım", // tek tarih: belirsiz, tahmin yok
    "Villa Testo açalım", // tarih yok
    "10-15 Aralık müsait mi?", // soru
    "10-15 Aralık kapatalım", // kapatma
    "Villa 15-20 Aralık müsait değil", // olumsuz: kapatma
    "10-15 Aralık açalım, 20-22 Aralık açalım", // birden çok öğe
    "10-15 Aralık rezervasyon iptal", // iptal (bu aşamada yok)
  ])("uygun değil: %s", (text) => {
    expect(open(text)).toBeNull();
  });

  it("yetkisiz gönderen veya villasız grup → aday yok", () => {
    expect(open("10-15 Aralık açalım", { role: null })).toBeNull();
    expect(open("10-15 Aralık açalım", { group: null })).toBeNull();
  });

  it("kapatma kuralı açma öğesini, açma kuralı kapatma öğesini seçmez", () => {
    expect(cand("Villa Testo 10–15 Aralık açalım.")).toBeNull();
    expect(open("Villa Testo 10–15 Aralık kapatalım.")).toBeNull();
  });

  it("'kapattık' tek başına kapatma bildirimi olarak kalır", () => {
    const [it0] = parseCalendarMessage("Villa Testo 10-15 Aralık kapattık", TODAY).items;
    expect(it0!.action).toBe("close");
  });
});
