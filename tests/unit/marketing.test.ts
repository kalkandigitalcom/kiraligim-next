import { describe, expect, it } from "vitest";

import { SAMPLE_PERIODS, SAMPLE_PRESETS } from "@/app/site/(tanitim)/_components/sample";
import {
  FAQ_ITEMS,
  INDEXING_ENABLED,
  loginHref,
  NAV_ITEMS,
  PLAN_FEATURES,
  PRICE_NOTE,
  ROADMAP_ITEMS,
  robotsPolicy,
  SECTION_IDS,
  signupCta,
  SITE_COPY,
  sitemapUrls,
  TRIAL_DAYS,
} from "@/config/marketing";
import { quoteStay } from "@/lib/pricing";

const base = {
  indexingEnabled: true,
  isProduction: true,
  isSiteHost: true,
  publicUrl: "https://kiraligim.com",
};

describe("tanıtım sitesi yayın kuralları", () => {
  it("indeksleme yayın koşulları hazır olana kadar kapalı", () => {
    expect(INDEXING_ENABLED).toBe(false);
  });

  it("robots: yalnız üç koşul birlikteyken açılır", () => {
    expect(robotsPolicy(base)).toEqual({
      rules: [{ userAgent: "*", allow: "/" }],
      sitemap: "https://kiraligim.com/sitemap.xml",
    });
    const closed = { rules: [{ userAgent: "*", disallow: "/" }] };
    expect(robotsPolicy({ ...base, indexingEnabled: false })).toEqual(closed);
    expect(robotsPolicy({ ...base, isProduction: false })).toEqual(closed);
    expect(robotsPolicy({ ...base, isSiteHost: false })).toEqual(closed);
  });

  it("sitemap: kapalıyken boş, açıkken kök alan adı yolları", () => {
    expect(sitemapUrls({ ...base, indexingEnabled: false })).toEqual([]);
    expect(sitemapUrls({ ...base, isSiteHost: false })).toEqual([]);
    expect(sitemapUrls(base)).toEqual(["https://kiraligim.com/"]);
  });
});

describe("deneme düğmesi", () => {
  const app = "https://app.kiraligim.com";

  it("kayıt kapalıyken kayıt sayfasına gitmez; sayfadaki deneme bölümüne iner", () => {
    const cta = signupCta(false, app);
    expect(cta.href).toBe(`/#${SECTION_IDS.trial}`);
    expect(cta.href).not.toContain("kayit");
    expect(cta.open).toBe(false);
    expect(cta.label).toBe(SITE_COPY.trialSoonLabel);
  });

  it("kayıt açıkken panel alan adındaki kayıt sayfası", () => {
    const cta = signupCta(true, app);
    expect(cta).toMatchObject({ href: `${app}/kayit`, open: true, external: true });
    expect(cta.label).toBe("14 gün ücretsiz deneyin");
  });

  it("giriş bağlantısı panel alan adında", () => {
    expect(loginHref(app)).toBe(`${app}/giris`);
  });
});

describe("içerik", () => {
  it("menü bağlantıları sayfadaki bölümlere gider", () => {
    const ids = Object.values(SECTION_IDS);
    for (const item of NAV_ITEMS) expect(ids).toContain(item.href.replace("/#", ""));
  });

  it("fiyat uydurulmaz", () => {
    expect(PRICE_NOTE).toBe("Deneme sonrası fiyat yakında açıklanacak");
    const all = JSON.stringify(SITE_COPY);
    expect(all).not.toMatch(/₺|TL\b|\d+[.,]?\d*\s?(TL|lira)/i);
  });
});

describe("içerik dürüstlüğü", () => {
  const text = JSON.stringify({ SITE_COPY, FAQ_ITEMS, PLAN_FEATURES, ROADMAP_ITEMS });

  it("fiyat, müşteri sayısı veya iletişim bilgisi uydurulmaz", () => {
    expect(text).not.toMatch(/₺|(^|\s)TL(\s|$)|Türk lirası/);
    expect(text).not.toMatch(/\b\d{2,}\+?\s*(müşteri|ev sahibi|kullanıcı|işletme)/i);
    expect(text).not.toMatch(/@|\+90|0\s?5\d{2}/);
  });

  it("geliştirilen özellikler çalışıyor gibi sunulmaz", () => {
    for (const r of ROADMAP_ITEMS) expect(text).toContain(r.title);
    const plan = PLAN_FEATURES.join(" ");
    expect(plan).not.toMatch(/iCal|KBS|QR|misafir formu|ekip/i);
    const kbs = FAQ_ITEMS.find((f) => f.q.includes("KBS"))!;
    expect(kbs.a).toMatch(/bildirim yapmaz/);
    const ical = FAQ_ITEMS.find((f) => f.q.includes("Airbnb"))!;
    expect(ical.a).toMatch(/^Henüz değil/);
  });

  it("plan tek mülk ve deneme süresi", () => {
    expect(PLAN_FEATURES[0]).toBe("1 mülk");
    expect(TRIAL_DAYS).toBe(14);
  });
});

describe("örnek hesaplayıcı (quoteStay ile)", () => {
  const q = (a: string, b: string) => quoteStay(a, b, SAMPLE_PERIODS);

  it("yüksek sezon 10 gece: 1 hafta + 3 gece, temizlik yok", () => {
    const r = q("2027-07-03", "2027-07-13");
    expect(r.ok).toBe(true);
    expect(r.totalMinor).toBe(10_300_000);
    expect(r.cleaningFee).toBeNull();
  });

  it("Haziran 5 gece: temizlik ücreti eklenir", () => {
    const r = q("2027-06-14", "2027-06-19");
    expect(r.totalMinor).toBe(4_500_000);
    expect(r.cleaningFee?.amountMinor).toBe(250_000);
  });

  it("dönem geçişi iki parça; hazır örneklerin hepsi hesaplanır ya da eksik geceyi söyler", () => {
    expect(q("2027-06-27", "2027-07-05").segments).toHaveLength(2);
    for (const p of SAMPLE_PRESETS) {
      const r = q(p.checkIn, p.checkOut);
      expect(r.ok || r.issues.some((i) => i.kind === "unpriced")).toBe(true);
    }
    expect(q("2027-10-28", "2027-11-03").ok).toBe(false);
  });

  it("dönemler kesişmez ve tek para birimi", () => {
    for (let i = 1; i < SAMPLE_PERIODS.length; i++)
      expect(SAMPLE_PERIODS[i - 1]!.endDate).toBe(SAMPLE_PERIODS[i]!.startDate);
    expect(new Set(SAMPLE_PERIODS.map((p) => p.currency)).size).toBe(1);
  });
});
