import { describe, expect, it } from "vitest";

import {
  parseCalendarMessage,
  WA_CALENDAR_FLAGS,
  type WaCalendarItem,
} from "@/lib/wa-calendar-parse";
import { WA_PROPOSAL_LIMITS, WA_WORKER_ERRORS, WA_WORKER_LIMITS } from "@/lib/whatsapp-meta";
import {
  type BusyRow,
  buildStoreItem,
  busyRange,
  clip,
  conflictFreeFor,
} from "@/server/whatsapp/calendar/proposal";
import { resolveProposal, type ResolveContext } from "@/server/whatsapp/calendar/resolve";
import { parseForMessage, safeError } from "@/server/whatsapp/calendar/worker";

/** A2c: worker'ın saf parçaları — öğe üretimi, çakışma anlamı, tarih referansı, güvenli log. */
const TODAY = "2026-11-10";
const WS = "ws-1";
const ctx: ResolveContext = {
  workspaceId: WS,
  villas: [
    { id: "mavi", workspaceId: WS, name: "Villa Mavi" },
    { id: "asya", workspaceId: WS, name: "Villa Asya" },
  ],
  groupPropertyId: "mavi",
};
const one = (text: string): WaCalendarItem => {
  const items = parseCalendarMessage(text, TODAY).items;
  expect(items, text).toHaveLength(1);
  return items[0]!;
};
const build = (
  text: string,
  over: {
    busy?: BusyRow[] | null;
    role?: "owner" | "manager" | "staff" | null;
    ctx?: ResolveContext;
  } = {},
) => {
  const item = one(text);
  return buildStoreItem({
    item,
    itemNo: 0,
    villa: resolveProposal(item, over.ctx ?? ctx),
    busy: over.busy === undefined ? [] : over.busy,
    senderRole: over.role === undefined ? "owner" : over.role,
  });
};
const BLOCK: BusyRow = {
  kind: "block",
  recordId: "r1",
  checkIn: "2027-06-14",
  checkOut: "2027-06-18",
  status: "confirmed",
};

describe("öğe (app_wa_store_proposals girdisi)", () => {
  it("owner, adlı villa, çakışmasız kapatma: nedensiz; alanlar veritabanı adlarıyla", () => {
    expect(build("Villa Mavi 15-20 Haziran kapalı")).toEqual({
      item_no: 0,
      parser_version: 3,
      message_excerpt: "Villa Mavi 15-20 Haziran kapalı",
      action: "close",
      villa_name_raw: "Mavi",
      property_id: "mavi",
      villa_resolution: "named",
      candidate_property_ids: [],
      check_in: "2027-06-15",
      check_out: "2027-06-20",
      reservation_status: null,
      flags: ["year_inferred"],
      conflicts: [],
      score: 100,
      band: "high",
      review_reasons: [],
    });
  });

  it("başka villanın adı yazılsa da grubun villası (A2e); bilgi bayrağı, inceleme nedeni yok", () => {
    const s = build("Villa Asya 15-20 Haziran kapalı");
    expect([s.property_id, s.villa_resolution]).toEqual(["mavi", "single"]);
    expect(s.flags).toEqual(["year_inferred", "villa_name_mismatch"]);
    expect(s.review_reasons).toEqual([]);
  });

  it("grup villasızsa ada göre eşleşen villa (grup dışı kavramı yok)", () => {
    const s = build("Villa Asya 15-20 Haziran kapalı", { ctx: { ...ctx, groupPropertyId: null } });
    expect([s.property_id, s.villa_resolution, s.review_reasons]).toEqual(["asya", "named", []]);
  });

  it("staff ve rolsüz gönderen tek tıkla onaylanamaz", () => {
    expect(build("Villa Mavi 15-20 Haziran kapalı", { role: "staff" }).review_reasons).toEqual([
      "staff_review_required",
    ]);
    expect(build("Villa Mavi 15-20 Haziran kapalı", { role: null }).review_reasons).toContain(
      "sender_unverified",
    );
  });

  it("çakışma: kapatma/rezervasyon için neden; açma/iptal için yalnız bilgi", () => {
    const close = build("Villa Mavi 15-20 Haziran kapalı", { busy: [BLOCK] });
    expect(close.review_reasons).toContain("conflict");
    expect(close.conflicts).toEqual([
      {
        kind: "block",
        record_id: "r1",
        check_in: "2027-06-14",
        check_out: "2027-06-18",
        status: "confirmed",
      },
    ]);
    const open = build("Villa Mavi 15-20 Haziran tekrar açıldı", { busy: [BLOCK] });
    expect(open.action).toBe("open");
    expect(open.review_reasons).not.toContain("conflict");
    expect(open.review_reasons).toContain("action_requires_review");
    // Çakışma sorgulanamadı: temkinli.
    expect(build("Villa Mavi 15-20 Haziran kapalı", { busy: null }).review_reasons).toContain(
      "conflict",
    );
  });

  it("rezervasyon durumu yalnız reserve için", () => {
    const r = build("Villa Mavi 22-29 Haziran opsiyonlu, cumaya kadar cevap verecekler");
    expect([r.action, r.reservation_status]).toEqual(["reserve", "pending"]);
    expect(build("Villa Mavi 15-20 Haziran kapalı").reservation_status).toBeNull();
  });

  it("belirsiz ve bulunamayan villa: villa alanı boş, adaylar/bayrak dolu", () => {
    const amb = build("Villa Mavi 15-20 Haziran kapalı", {
      ctx: {
        ...ctx,
        groupPropertyId: null,
        villas: [...ctx.villas, { id: "m2", workspaceId: WS, name: "Mavi Villa" }],
      },
    });
    expect([amb.property_id, amb.villa_resolution, amb.candidate_property_ids]).toEqual([
      null,
      "ambiguous",
      ["m2", "mavi"], // grup villasız: ada göre sıralı
    ]);
    const none = build("Villa Lavnta 15-20 Haziran kapalı", {
      ctx: { ...ctx, groupPropertyId: null },
    });
    expect([none.property_id, none.villa_resolution]).toEqual([null, "none"]);
    expect(none.flags).toContain("villa_not_found");
    expect(none.review_reasons).toContain("villa_unresolved");
  });

  it("veritabanı sınırları: alıntı ≤ 500, villa adı ≤ 120, diziler ≤ 20, tutarsız çıkış boş", () => {
    const item = one("Villa Mavi 15-20 Haziran kapalı");
    const long = buildStoreItem({
      item: {
        ...item,
        excerpt: "😀".repeat(600),
        villaName: "Ç".repeat(200),
        checkOut: "2027-06-10",
        flags: Array.from(
          { length: 30 },
          (_, n) => WA_CALENDAR_FLAGS[n % WA_CALENDAR_FLAGS.length]!,
        ),
      },
      itemNo: 9,
      villa: {
        resolution: "none",
        propertyId: null,
        candidateIds: [],
        tier: null,
        serverFlags: ["villa_not_found"],
      },
      busy: null,
      senderRole: "owner",
    });
    expect(Array.from(long.message_excerpt)).toHaveLength(WA_PROPOSAL_LIMITS.excerptMax);
    expect(long.message_excerpt).toBe("😀".repeat(500)); // vekil çifti bölünmedi
    expect(Array.from(long.villa_name_raw!)).toHaveLength(WA_PROPOSAL_LIMITS.villaNameMax);
    expect(long.check_out).toBeNull();
    expect(long.flags.length).toBeLessThanOrEqual(WA_PROPOSAL_LIMITS.arrayMax);
    expect(long.item_no).toBe(9);
    expect(JSON.parse(JSON.stringify(long))).toEqual(long);
  });
});

describe("yardımcılar", () => {
  it("clip: kod noktasına göre", () => {
    expect(clip("abc", 5)).toBe("abc");
    expect(clip("😀😀😀", 2)).toBe("😀😀");
  });

  it("busyRange: iki tarih, çıkış > giriş, en fazla sınır", () => {
    expect(busyRange({ checkIn: "2027-06-15", checkOut: "2027-06-20" }, 400)).toEqual({
      from: "2027-06-15",
      to: "2027-06-20",
    });
    expect(busyRange({ checkIn: "2027-06-15", checkOut: null }, 400)).toBeNull();
    expect(busyRange({ checkIn: "2027-06-15", checkOut: "2027-06-15" }, 400)).toBeNull();
    expect(busyRange({ checkIn: "2027-01-01", checkOut: "2028-06-01" }, 400)).toBeNull();
  });

  it("conflictFreeFor", () => {
    expect(conflictFreeFor("close", [])).toBe(true);
    expect(conflictFreeFor("reserve", [BLOCK])).toBe(false);
    expect(conflictFreeFor("cancel", [BLOCK])).toBe(true);
    expect(conflictFreeFor("close", null)).toBe(false);
    expect(conflictFreeFor(null, [])).toBe(true);
  });
});

describe("tarih referansı: mesajın gönderildiği gün (Europe/Istanbul)", () => {
  it("UTC'de 31 Aralık 22:30 = İstanbul'da 1 Ocak: yıl çıkarımı gönderim gününe göre", () => {
    const items = parseForMessage("Villa Mavi 5-8 Ocak kapalı", new Date("2026-12-31T22:30:00Z"));
    expect([items[0]!.checkIn, items[0]!.checkOut]).toEqual(["2027-01-05", "2027-01-08"]);
    expect(items[0]!.flags).not.toContain("date_past");
  });

  it("aynı mesaj her denemede aynı sonucu verir (işleme zamanından bağımsız)", () => {
    const sent = new Date("2026-11-10T09:00:00Z");
    expect(parseForMessage("Villa Mavi 12-18 Temmuz kapalı", sent)).toEqual(
      parseForMessage("Villa Mavi 12-18 Temmuz kapalı", new Date(sent.getTime())),
    );
  });

  it("en fazla 10 öğe", () => {
    const text = Array.from(
      { length: 12 },
      (_, i) => `Villa Mavi ${i + 1}-${i + 2} Ağustos kapalı`,
    ).join("\n");
    expect(parseForMessage(text, new Date("2026-11-10T09:00:00Z")).length).toBeLessThanOrEqual(
      WA_PROPOSAL_LIMITS.itemsPerMessage,
    );
  });
});

describe("güvenli hata özeti (log)", () => {
  it("sorgu parametreleri ve veritabanı ayrıntısı log'a girmez", () => {
    const pg = Object.assign(new Error("new row violates check constraint"), {
      code: "23514",
      detail: "Failing row contains (Villa Mavi kapalı, 905321220001)",
    });
    const drizzleLike = Object.assign(
      new Error("Failed query: select ... params: Villa Mavi 15-20 kapalı,905321220001"),
      { cause: pg },
    );
    const out = safeError(drizzleLike);
    expect(out).toEqual({ code: "23514" });
    expect(JSON.stringify(out)).not.toMatch(/Villa|9053|Failing/);
  });

  it("yalnız bizim kısa kodlarımız geçer", () => {
    const own = Object.assign(new Error("wa_context_changed"), { code: "55000" });
    expect(safeError({ cause: own })).toEqual({ code: "55000", reason: "wa_context_changed" });
    expect(safeError(new TypeError("Villa Mavi 905321220001"))).toEqual({ reason: "TypeError" });
    expect(safeError("düz metin 905321220001")).toEqual({});
  });
});

describe("worker sabitleri", () => {
  it("bütçe zamanlama aralığından kısa; parti kilit süresine uygun; hata kodları biçimde", () => {
    expect(WA_WORKER_LIMITS.budgetMs).toBeLessThan(60_000);
    expect(WA_WORKER_LIMITS.batchSize).toBeLessThanOrEqual(WA_PROPOSAL_LIMITS.claimBatchMax);
    expect(WA_WORKER_LIMITS.busyMaxNights).toBeLessThanOrEqual(400);
    for (const c of WA_WORKER_ERRORS) expect(c).toMatch(/^[a-z0-9_]{1,60}$/);
  });
});
