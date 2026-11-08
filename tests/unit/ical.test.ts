import { describe, expect, it } from "vitest";

import { TONE_BAR } from "@/app/host/(panel)/takvim/_components/calendar-styles";
import { EXTERNAL_BAR } from "@/app/host/(panel)/takvim/_components/calendar-styles";
import {
  type CalendarExternal,
  dayLabel,
  layoutWeek,
  mergeExternal,
  monthGrid,
  splitExternal,
} from "@/lib/calendar";
import {
  buildIcsFeed,
  durationDays,
  EXPORT_SUMMARY,
  foldLine,
  icsDate,
  parseIcs,
  parseProp,
  unfoldLines,
} from "@/lib/ical";
import {
  icalExportUrl,
  icalFailureNote,
  ICAL_TOKEN_RE,
  isOwnExportUid,
  maskIcalUrl,
  normalizeIcalUrl,
} from "@/lib/ical-meta";
import { createIcsFetcher, isBlockedHost, isPublicAddress } from "@/server/ical/fetch";
import { sourceInput } from "@/server/ical/service";
import { conflictMessage } from "@/server/reservations/service";

const TODAY = "2026-11-08";

const cal = (...events: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//TR", ...events, "END:VCALENDAR"].join("\r\n");

const ev = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");

describe("iCal ayrıştırma (parseIcs)", () => {
  it("tüm gün olay: DTEND hariç, UID korunur", async () => {
    const r = await parseIcs(
      cal(ev("UID:a1@airbnb.com", "DTSTART;VALUE=DATE:20270610", "DTEND;VALUE=DATE:20270615")),
      TODAY,
    );
    expect(r).toMatchObject({
      ok: true,
      events: [{ uid: "a1@airbnb.com", start: "2027-06-10", end: "2027-06-15" }],
    });
  });

  it("UTC zaman Europe/Istanbul gününe çevrilir (21:00Z → ertesi gün)", async () => {
    const r = await parseIcs(
      cal(ev("UID:u", "DTSTART:20270610T210000Z", "DTEND:20270615T080000Z")),
      TODAY,
    );
    expect(r.ok && r.events[0]).toMatchObject({ start: "2027-06-11", end: "2027-06-15" });
  });

  it("TZID'li ve yüzer zaman yazıldığı yerel gündür", async () => {
    const r = await parseIcs(
      cal(
        ev(
          "UID:t1",
          "DTSTART;TZID=Europe/Berlin:20270610T150000",
          "DTEND;TZID=Europe/Berlin:20270612T110000",
        ),
        ev("UID:t2", "DTSTART:20270701T140000", "DTEND:20270703T100000"),
      ),
      TODAY,
    );
    expect(r.ok && r.events).toEqual([
      { uid: "t1", start: "2027-06-10", end: "2027-06-12" },
      { uid: "t2", start: "2027-07-01", end: "2027-07-03" },
    ]);
  });

  it("DTEND yoksa DURATION (gün/hafta) ya da tek gece; bitiş ≤ başlangıç tek gece", async () => {
    const r = await parseIcs(
      cal(
        ev("UID:d1", "DTSTART;VALUE=DATE:20270101", "DURATION:P1W"),
        ev("UID:d2", "DTSTART;VALUE=DATE:20270201"),
        ev("UID:d3", "DTSTART:20270301T120000Z", "DTEND:20270301T150000Z"),
      ),
      TODAY,
    );
    expect(r.ok && r.events).toEqual([
      { uid: "d1", start: "2027-01-01", end: "2027-01-08" },
      { uid: "d2", start: "2027-02-01", end: "2027-02-02" },
      { uid: "d3", start: "2027-03-01", end: "2027-03-02" },
    ]);
    expect(durationDays("P3D")).toBe(3);
    expect(durationDays("PT36H")).toBe(2);
    expect(durationDays("nonsense")).toBeNull();
  });

  it("iptal, şeffaf, geçmiş, 3 yıldan ileri ve kendi dışa aktardığımız olaylar atlanır", async () => {
    const r = await parseIcs(
      cal(
        ev("UID:c", "STATUS:CANCELLED", "DTSTART;VALUE=DATE:20270610", "DTEND;VALUE=DATE:20270611"),
        ev(
          "UID:tr",
          "TRANSP:TRANSPARENT",
          "DTSTART;VALUE=DATE:20270610",
          "DTEND;VALUE=DATE:20270611",
        ),
        ev("UID:p", "DTSTART;VALUE=DATE:20261001", "DTEND;VALUE=DATE:20261108"),
        ev("UID:f", "DTSTART;VALUE=DATE:20300101", "DTEND;VALUE=DATE:20300105"),
        ev(
          "UID:0192f0aa-0000-7000-8000-000000000001@kiraligim.com",
          "DTSTART;VALUE=DATE:20270610",
          "DTEND;VALUE=DATE:20270611",
        ),
        ev("UID:ok", "DTSTART;VALUE=DATE:20261107", "DTEND;VALUE=DATE:20261110"),
      ),
      TODAY,
    );
    expect(r.ok && r.events.map((e) => e.uid)).toEqual(["ok"]);
    expect(r.ok && r.stats).toMatchObject({
      cancelled: 1,
      transparent: 1,
      past: 1,
      farFuture: 1,
      own: 1,
    });
  });

  it("katlanmış satırlar açılır; VALARM gibi alt bileşenler ve özet/açıklama okunmaz", async () => {
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:uzun-",
      " uid-katlanmis",
      "SUMMARY:Ayşe Yılmaz - Rezervasyon",
      "DTSTART;VALUE=DATE:20270610",
      "DTEND;VALUE=DATE:20270612",
      "BEGIN:VALARM",
      "TRIGGER:-PT15M",
      "DTSTART;VALUE=DATE:20200101",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    const r = await parseIcs(text, TODAY);
    expect(r.ok && r.events).toEqual([
      { uid: "uzun-uid-katlanmis", start: "2027-06-10", end: "2027-06-12" },
    ]);
    expect(JSON.stringify(r)).not.toContain("Ayşe");
  });

  it("UID yoksa tarihlerden kararlı anahtar; tekrar eden UID ve RECURRENCE-ID ayrışır", async () => {
    const body = cal(
      ev("DTSTART;VALUE=DATE:20270610", "DTEND;VALUE=DATE:20270612"),
      ev("UID:x", "DTSTART;VALUE=DATE:20270701", "DTEND;VALUE=DATE:20270703"),
      ev("UID:x", "DTSTART;VALUE=DATE:20270801", "DTEND;VALUE=DATE:20270803"),
      ev(
        "UID:r",
        "RECURRENCE-ID;VALUE=DATE:20270901",
        "DTSTART;VALUE=DATE:20270901",
        "DTEND;VALUE=DATE:20270902",
      ),
    );
    const a = await parseIcs(body, TODAY);
    const b = await parseIcs(body, TODAY);
    expect(a).toEqual(b);
    const uids = a.ok ? a.events.map((e) => e.uid) : [];
    expect(uids).toContain("nouid:2027-06-10:2027-06-12");
    expect(uids).toContain("x");
    expect(uids).toContain("x#2027-08-01");
    expect(uids).toContain("r#20270901");
    expect(new Set(uids).size).toBe(uids.length);
  });

  it("çok uzun UID özetlenir (veritabanı sınırı 255)", async () => {
    const r = await parseIcs(
      cal(ev(`UID:${"a".repeat(400)}`, "DTSTART;VALUE=DATE:20270610", "DTEND;VALUE=DATE:20270611")),
      TODAY,
    );
    const uid = r.ok ? r.events[0]!.uid : "";
    expect(uid).toMatch(/^h:[0-9a-f]{64}$/);
  });

  it("bozuk tarih sayılır ve atlanır; VCALENDAR değilse not_ical", async () => {
    const r = await parseIcs(cal(ev("UID:b", "DTSTART;VALUE=DATE:20270230")), TODAY);
    expect(r).toMatchObject({ ok: true, events: [], stats: { invalid: 1 } });
    expect(await parseIcs("<html>Giriş yapın</html>", TODAY)).toEqual({
      ok: false,
      error: "not_ical",
    });
    expect(await parseIcs("", TODAY)).toEqual({ ok: false, error: "not_ical" });
  });

  it("2000'den fazla kabul edilen olay → too_many_events", async () => {
    const many = Array.from({ length: 2001 }, (_, i) =>
      ev(`UID:m${i}`, "DTSTART;VALUE=DATE:20270610", "DTEND;VALUE=DATE:20270611"),
    );
    expect(await parseIcs(cal(...many), TODAY)).toEqual({ ok: false, error: "too_many_events" });
  });

  it("yardımcılar: satır açma, özellik ve tarih", () => {
    expect(unfoldLines("A:1\r\n 2\r\nB:3")).toEqual(["A:12", "B:3"]);
    expect(parseProp('DTSTART;TZID="Europe/Istanbul":20270610T100000')).toEqual({
      name: "DTSTART",
      params: { TZID: "Europe/Istanbul" },
      value: "20270610T100000",
    });
    expect(parseProp("bozuk")).toBeNull();
    expect(icsDate({ name: "DTSTART", params: {}, value: "20271231T220000Z" })).toEqual({
      date: "2028-01-01",
      timed: true,
    });
    expect(icsDate({ name: "DTSTART", params: {}, value: "2027-12-31" })).toBeNull();
  });
});

describe("iCal üretme (buildIcsFeed)", () => {
  const now = new Date("2026-11-08T12:34:56.789Z");
  const feed = buildIcsFeed({
    calendarName: "Villa Defne, Kalkan; deniz manzaralı – Kiralığım",
    events: [
      {
        id: "0192f0aa-0000-7000-8000-000000000001",
        checkIn: "2027-06-10",
        checkOut: "2027-06-15",
        createdAt: new Date("2026-10-01T10:00:00Z"),
        updatedAt: new Date("2026-10-02T11:00:00Z"),
      },
    ],
    now,
  });

  it("geçerli VCALENDAR/VEVENT; tüm gün tarihler, DTEND hariç, UID alan adı", () => {
    expect(feed.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(feed.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(feed).toContain("UID:0192f0aa-0000-7000-8000-000000000001@kiraligim.com\r\n");
    expect(feed).toContain("DTSTART;VALUE=DATE:20270610\r\n");
    expect(feed).toContain("DTEND;VALUE=DATE:20270615\r\n");
    expect(feed).toContain("DTSTAMP:20261108T123456Z\r\n");
    expect(feed).toContain("CREATED:20261001T100000Z\r\n");
    expect(feed).toContain("LAST-MODIFIED:20261002T110000Z\r\n");
    expect(feed).toContain(`SUMMARY:${EXPORT_SUMMARY}\r\n`);
    expect(feed).toContain("X-WR-CALNAME:Villa Defne\\, Kalkan\\; deniz manzaralı – Kiralığım");
  });

  it("satırlar 75 baytı geçmez ve kendi ayrıştırıcımız akışı geri okuyabilir (döngü emniyeti)", async () => {
    for (const line of feed.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    const back = await parseIcs(feed, "2026-11-08");
    // Kendi UID'lerimiz içe aktarmada atlanır.
    expect(back).toMatchObject({ ok: true, events: [], stats: { own: 1 } });
  });

  it("foldLine çok baytlı karakteri bölmez", () => {
    const long = `X-WR-CALNAME:${"ğ".repeat(60)}`;
    const folded = foldLine(long);
    expect(folded.split("\r\n ").join("")).toBe(long);
    for (const part of folded.split("\r\n")) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    }
  });

  it("boş akış geçerli bir takvimdir", () => {
    const empty = buildIcsFeed({ calendarName: "Boş", events: [], now });
    expect(empty).not.toContain("BEGIN:VEVENT");
    expect(empty).toContain("BEGIN:VCALENDAR");
  });
});

describe("iCal adresleri", () => {
  it("normalizeIcalUrl: webcal → https, yalnız http(s), kullanıcı bilgisi/port yok", () => {
    expect(normalizeIcalUrl(" webcal://www.airbnb.com/calendar/ical/1.ics?s=abc ")).toBe(
      "https://www.airbnb.com/calendar/ical/1.ics?s=abc",
    );
    expect(normalizeIcalUrl("https://admin.booking.com/hotel/ical.ics#x")).toBe(
      "https://admin.booking.com/hotel/ical.ics",
    );
    expect(normalizeIcalUrl("ftp://x.com/a.ics")).toBeNull();
    expect(normalizeIcalUrl("https://u:p@x.com/a.ics")).toBeNull();
    expect(normalizeIcalUrl("https://x.com:8443/a.ics")).toBeNull();
    expect(normalizeIcalUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeIcalUrl(`https://x.com/${"a".repeat(3000)}`)).toBeNull();
  });

  it("maskIcalUrl gizli kısmı göstermez", () => {
    expect(maskIcalUrl("https://www.airbnb.com/calendar/ical/123.ics?s=gizli")).toBe(
      "https://www.airbnb.com/calendar/…",
    );
  });

  it("dışa aktarma adresi ve belirteç biçimi", () => {
    const t = "A".repeat(43);
    expect(ICAL_TOKEN_RE.test(t)).toBe(true);
    expect(ICAL_TOKEN_RE.test("A".repeat(42))).toBe(false);
    expect(icalExportUrl("https://app.kiraligim.com", t)).toBe(
      `https://app.kiraligim.com/api/ical/${t}.ics`,
    );
    expect(isOwnExportUid("abc@KIRALIGIM.com")).toBe(true);
    expect(isOwnExportUid("abc@airbnb.com")).toBe(false);
  });
});

describe("SSRF koruması", () => {
  it("özel, yerel ve ayrılmış adresler genel değildir", () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:a00:1",
      "::ffff:7f00:1",
      "64:ff9b::a00:1",
    ]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicAddress("2a03:2880:f12f:83:face:b00c::25de")).toBe(true);
    expect(isPublicAddress("bozuk")).toBe(false);
  });

  it("çözülen adreslerden biri özelse istek yapılmaz; yerel ad ve IP reddedilir", async () => {
    const fetcher = createIcsFetcher({
      resolver: async (host) =>
        host === "karma.example"
          ? [
              { address: "93.184.216.34", family: 4 },
              { address: "10.0.0.7", family: 4 },
            ]
          : [{ address: "169.254.169.254", family: 4 }],
    });
    expect(await fetcher("https://karma.example/a.ics")).toEqual({
      ok: false,
      code: "blocked_address",
    });
    expect(await fetcher("https://metadata.example/a.ics")).toEqual({
      ok: false,
      code: "blocked_address",
    });
    expect(await fetcher("http://127.0.0.1/a.ics")).toEqual({ ok: false, code: "blocked_address" });
    expect(await fetcher("http://[::1]/a.ics")).toEqual({ ok: false, code: "blocked_address" });
    expect(await fetcher("https://localhost/a.ics")).toEqual({
      ok: false,
      code: "blocked_address",
    });
    expect(await fetcher("not a url")).toEqual({ ok: false, code: "invalid_url" });
  });

  it("DNS hatası dns kodu döner", async () => {
    const fetcher = createIcsFetcher({
      resolver: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(await fetcher("https://yok.example/a.ics")).toEqual({ ok: false, code: "dns" });
  });
});

describe("takvim: harici doluluk ayrı ve farklı renkte", () => {
  const x = (id: string, source: string, checkIn: string, checkOut: string): CalendarExternal => ({
    id,
    sourceId: `s-${source}`,
    sourceName: source,
    checkIn,
    checkOut,
    sourceStatus: "ok",
    lastSuccessAt: "2026-11-08T10:00:00.000Z",
    lastSyncedAt: "2026-11-08T10:00:00.000Z",
  });

  it("harici renk Kiraligim tonlarından farklıdır", () => {
    for (const tone of Object.values(TONE_BAR)) expect(EXTERNAL_BAR).not.toBe(tone);
    expect(EXTERNAL_BAR).toContain("violet");
  });

  it("aynı tarihleri kapatan kaynaklar tek şeritte birleşir, ayrıntı korunur", () => {
    const spans = mergeExternal([
      x("1", "Airbnb", "2027-06-10", "2027-06-15"),
      x("2", "Booking.com", "2027-06-12", "2027-06-18"),
      x("3", "Airbnb", "2027-06-18", "2027-06-20"),
      x("4", "Vrbo", "2027-07-01", "2027-07-03"),
    ]);
    expect(spans.map((s) => [s.checkIn, s.checkOut, s.items.length])).toEqual([
      ["2027-06-10", "2027-06-20", 3],
      ["2027-07-01", "2027-07-03", 1],
    ]);
    const grid = monthGrid("2027-06", "2027-06-01");
    const week = grid.weeks.find((w) => w.start === "2027-06-07")!;
    expect(layoutWeek(week.start, spans)).toEqual([
      { entryId: "ext:2027-06-10", startHalf: 7, endHalf: 14, startsHere: true, endsHere: false },
    ]);
  });

  it("şerit parçaları: kaynak adı yalnız o günleri kapatan kaynaklarla etiketlenir", () => {
    const pieces = splitExternal(
      mergeExternal([
        x("1", "Booking.com", "2026-11-19", "2026-11-22"),
        x("2", "Airbnb", "2026-11-20", "2026-11-21"),
        x("3", "Booking.com", "2026-11-22", "2026-11-24"),
      ]),
    );
    expect(pieces.map((p) => [p.checkIn, p.checkOut, p.names, p.startsSpan, p.endsSpan])).toEqual([
      ["2026-11-19", "2026-11-20", ["Booking.com"], true, false],
      ["2026-11-20", "2026-11-21", ["Airbnb", "Booking.com"], false, false],
      // Aynı kaynağın bitişik olayları tek parça; Airbnb'nin adı bu günlere taşınmaz.
      ["2026-11-21", "2026-11-24", ["Booking.com"], false, true],
    ]);
    // Parçalar yarım gün modelinde boşluksuz ve üst üste binmeden dizilir.
    const segs = layoutWeek("2026-11-16", pieces);
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.startHalf).toBe(segs[i - 1]!.endHalf);
  });

  it("farklı kaynakların bitişik tarihleri tek etikette birleşmez", () => {
    const pieces = splitExternal(
      mergeExternal([
        x("1", "Airbnb", "2027-06-10", "2027-06-12"),
        x("2", "Vrbo", "2027-06-12", "2027-06-14"),
      ]),
    );
    expect(pieces.map((p) => [p.checkIn, p.checkOut, p.names.join(",")])).toEqual([
      ["2027-06-10", "2027-06-12", "Airbnb"],
      ["2027-06-12", "2027-06-14", "Vrbo"],
    ]);
    expect(pieces.map((p) => [p.startsSpan, p.endsSpan])).toEqual([
      [true, false],
      [false, true],
    ]);
    // Ayrık aralıklar ayrı birleşik şerit olarak kalır.
    const apart = splitExternal(
      mergeExternal([
        x("1", "Airbnb", "2027-06-01", "2027-06-03"),
        x("2", "Airbnb", "2027-06-05", "2027-06-06"),
      ]),
    );
    expect(apart.map((p) => [p.startsSpan, p.endsSpan])).toEqual([
      [true, true],
      [true, true],
    ]);
  });

  it("gün etiketi harici takvimi kaynak adıyla anar", () => {
    const grid = monthGrid("2027-06", "2027-06-01");
    const day = grid.weeks.flatMap((w) => w.days).find((d) => d.date === "2027-06-12")!;
    expect(dayLabel(day, [], [x("1", "Airbnb", "2027-06-10", "2027-06-15")])).toContain(
      "dolu: harici takvim Airbnb",
    );
  });

  it("çakışma mesajı harici takvimi ayrıca belirtir", () => {
    expect(
      conflictMessage(
        [],
        [{ sourceName: "Airbnb", checkIn: "2027-06-10", checkOut: "2027-06-15" }],
      ),
    ).toBe("Seçilen tarihler dolu: 10–15 Haziran 2027 (harici takvim: Airbnb).");
  });
});

describe("iCal kaynak formu: yerel/özel adresler kayıttan önce reddedilir", () => {
  it.each([
    "localhost",
    "localhost.",
    "LOCALHOST",
    "api.localhost",
    "nas.local",
    "127.0.0.1",
    "10.0.0.5",
    "172.16.4.1",
    "192.168.1.10",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "[::1]",
    "[fe80::1]",
    "[fd00::1]",
    "[::ffff:127.0.0.1]",
  ])("engelli: %s", (host) => {
    expect(isBlockedHost(host)).toBe(true);
  });

  it.each([
    "www.airbnb.com",
    "admin.booking.com",
    "calendar.google.com",
    "8.8.8.8",
    "[2606:4700::1]",
  ])("genel: %s", (host) => {
    expect(isBlockedHost(host)).toBe(false);
  });

  it.each([
    "http://127.0.0.1/cal.ics",
    "http://localhost/cal.ics",
    "webcal://localhost/cal.ics",
    "https://192.168.1.10/cal.ics",
    "http://[::1]/cal.ics",
    "https://169.254.169.254/latest/meta-data",
    "http://2130706433/cal.ics",
    "http://0x7f.1/cal.ics",
    "https://router.lan/cal.ics",
  ])("form reddeder: %s", (url) => {
    const r = sourceInput.safeParse({ name: "Airbnb", url });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join("."))).toEqual(["url"]);
  });

  it("genel adres kabul edilir (webcal → https)", () => {
    const r = sourceInput.safeParse({
      name: "Airbnb",
      url: "webcal://www.airbnb.com/calendar/ical/1.ics?s=abc",
    });
    expect(r.success && r.data.url).toBe("https://www.airbnb.com/calendar/ical/1.ics?s=abc");
  });

  it("indirme anındaki denetim de sürer (DNS ile özel adrese çözülen ad)", async () => {
    const fetcher = createIcsFetcher({
      resolver: async () => [{ address: "10.1.2.3", family: 4 }],
    });
    expect(await fetcher("https://takvim.example/cal.ics")).toEqual({
      ok: false,
      code: "blocked_address",
    });
  });
});

describe("iCal hata açıklaması", () => {
  it("başarılı senkronu olan kaynakta eski tarihlerin korunduğu söylenir", () => {
    expect(icalFailureNote(1, true)).toBe(" Son başarılı senkronun tarihleri korunuyor.");
    expect(icalFailureNote(3, true)).toBe(
      " (3 denemedir başarısız; son başarılı senkronun tarihleri korunuyor.)",
    );
  });

  it("hiç başarılı senkronu olmayan kaynakta 'korunuyor' denmez", () => {
    expect(icalFailureNote(1, false)).toBe(
      " Henüz başarılı senkron olmadığından bu takvimden tarih alınmadı.",
    );
    expect(icalFailureNote(2, false)).toBe(
      " (2 denemedir başarısız; henüz başarılı senkron olmadığından bu takvimden tarih alınmadı.)",
    );
    expect(icalFailureNote(2, false)).not.toMatch(/korunuyor/);
  });
});
