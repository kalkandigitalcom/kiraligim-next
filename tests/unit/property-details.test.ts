import { describe, expect, it } from "vitest";

import { plainTextToHtml } from "@/lib/rich-text";
import { parseYouTubeId, youtubeWatchUrl } from "@/lib/youtube";
import { descriptionText, sanitizeDescription } from "@/server/properties/description";
import {
  parsePropertyInput,
  poolsFromRaw,
  propertyFormValues,
  propertyInput,
} from "@/server/properties/schema";

/** Mülk ek alanları: belge no, biçimlendirilmiş açıklama, YouTube, havuzlar. */
const base = {
  name: "Deniz Villa",
  propertyType: "villa",
  maxGuests: "6",
  bedrooms: "3",
  bathrooms: "2",
  province: "Antalya",
  district: "Kaş",
};
const errorsOf = (input: Record<string, unknown>) => {
  const r = parsePropertyInput({ ...base, ...input });
  return r.success
    ? {}
    : Object.fromEntries(r.error.issues.map((i) => [i.path.join("."), i.message]));
};

describe("YouTube bağlantıları", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL1", "dQw4w9WgXcQ"],
    ["http://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
    ["youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["  https://www.youtube.com/watch?v=a_b-C1d2E3f  ", "a_b-C1d2E3f"],
  ])("geçerli: %s", (url, id) => expect(parseYouTubeId(url)).toBe(id));

  it.each([
    "",
    "dQw4w9WgXcQ",
    "https://vimeo.com/123456",
    "https://www.youtube.com/@kanal",
    "https://www.youtube.com/playlist?list=PL123",
    "https://www.youtube.com/results?search_query=villa",
    "https://www.youtube.com/watch?v=kisa",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ1",
    "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
    "https://evil.example/?u=https://youtu.be/dQw4w9WgXcQ",
    "javascript:alert(1)//youtu.be/dQw4w9WgXcQ",
    "ftp://youtu.be/dQw4w9WgXcQ",
    "https://user:pw@youtu.be/dQw4w9WgXcQ",
    "https://youtu.be:8443/dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ/extra",
  ])("geçersiz: %j", (url) => expect(parseYouTubeId(url)).toBeNull());

  it("kimlikten standart izleme adresi", () => {
    expect(youtubeWatchUrl("dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("form: boş satırlar atlanır, kimlikler sırayla, geçersiz/yinelenen satır sırasıyla raporlanır", () => {
    const ok = propertyInput.parse({
      ...base,
      youtubeUrls: [
        "",
        "https://youtu.be/dQw4w9WgXcQ",
        "  ",
        "https://www.youtube.com/shorts/a_b-C1d2E3f",
      ],
    });
    expect(ok.youtubeUrls).toEqual(["dQw4w9WgXcQ", "a_b-C1d2E3f"]);
    expect(propertyInput.parse(base).youtubeUrls).toEqual([]);
    expect(
      errorsOf({
        youtubeUrls: [
          "https://youtu.be/dQw4w9WgXcQ",
          "https://vimeo.com/1",
          "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        ],
      }),
    ).toEqual({
      "youtubeUrls.1": "Geçerli bir YouTube video bağlantısı girin.",
      "youtubeUrls.2": "Bu video zaten eklendi.",
    });
    const many = Array.from(
      { length: 11 },
      (_, i) => `https://youtu.be/abcdefghi${String(i).padStart(2, "0")}`,
    );
    expect(errorsOf({ youtubeUrls: many })).toEqual({
      youtubeUrls: "En fazla 10 video eklenebilir.",
    });
  });

  it("FormData: aynı adlı alanlar liste olarak okunur", () => {
    const fd = new FormData();
    fd.append("youtubeUrls", "https://youtu.be/dQw4w9WgXcQ");
    fd.append("youtubeUrls", "");
    fd.set("poolKids", "yes");
    const v = propertyFormValues(fd);
    expect(v.youtubeUrls).toEqual(["https://youtu.be/dQw4w9WgXcQ", ""]);
    expect(v.poolKids).toBe("yes");
    expect(v.tourismLicenseNo).toBe("");
  });
});

describe("açıklama temizleme (sanitize)", () => {
  const clean = (html: string) => sanitizeDescription(html)?.html;

  it("izinli biçimler kalır; b/i/div dönüştürülür", () => {
    expect(clean("<p><strong>Kalın</strong> <em>italik</em> <u>altı çizili</u></p>")).toBe(
      "<p><strong>Kalın</strong> <em>italik</em> <u>altı çizili</u></p>",
    );
    expect(clean("<div><b>a</b><i>b</i></div><div>c<br>d</div>")).toBe(
      "<p><strong>a</strong><em>b</em></p><p>c<br />d</p>",
    );
  });

  it("bağlantılar: yalnız http/https/mailto; her zaman yeni sekme + noopener noreferrer nofollow", () => {
    expect(clean('<p><a href="https://ornek.com/a?b=1" onclick="x()" class="y">site</a></p>')).toBe(
      '<p><a href="https://ornek.com/a?b=1" target="_blank" rel="noopener noreferrer nofollow">site</a></p>',
    );
    expect(clean('<a href="mailto:info@ornek.com" target="_self" rel="opener">e</a>')).toBe(
      '<a href="mailto:info@ornek.com" target="_blank" rel="noopener noreferrer nofollow">e</a>',
    );
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "//evil.example",
      "/goreli",
      "https://",
    ]) {
      expect(clean(`<p><a href="${bad}">tıkla</a></p>`), bad).toBe("<p>tıkla</p>");
    }
  });

  it("zararlı HTML atılır: script, style, olay öznitelikleri, iframe, img, svg, form", () => {
    const evil = [
      "<script>alert(1)</script>",
      "<style>body{display:none}</style>",
      '<img src=x onerror="alert(1)">',
      '<iframe src="https://evil.example"></iframe>',
      '<svg onload="alert(1)"><circle/></svg>',
      '<p onmouseover="alert(1)" style="color:red">metin</p>',
      '<form action="https://evil.example"><input name="x"><button>Gönder</button></form>',
      "<object data='x'></object><embed src='x'>",
      '<a href="https://ok.example" style="position:fixed">ok</a>',
      "<!-- yorum --><math><mi>x</mi></math>",
    ].join("");
    const out = clean(evil)!;
    expect(out).not.toMatch(/<script|<style|<img|<iframe|<svg|<form|<input|<object|<embed|<math/i);
    expect(out).not.toMatch(/on[a-z]+=|style=|javascript:|alert\(1\)|display:none|<!--/i);
    expect(out).toContain("<p>metin</p>");
    expect(out).toContain(
      '<a href="https://ok.example/" target="_blank" rel="noopener noreferrer nofollow">ok</a>',
    );
  });

  it("görünür metin yoksa açıklama yok; düz metin hali paragrafları korur", () => {
    expect(sanitizeDescription("")).toBeUndefined();
    expect(sanitizeDescription("<p><br></p><p>&nbsp;</p>")).toBeUndefined();
    expect(sanitizeDescription("<script>x</script>")).toBeUndefined();
    expect(sanitizeDescription("<p>Bir &amp; iki</p><p>üç<br>dört</p>")).toEqual({
      html: "<p>Bir &amp; iki</p><p>üç<br />dört</p>",
      text: "Bir & iki\n\nüç\ndört",
    });
    expect(descriptionText("<p>&lt;b&gt; etiket değil</p>")).toBe("<b> etiket değil");
  });

  it("eski düz metin açıklamalar kayıpsız HTML'e çevrilir (kaçışlı)", () => {
    const legacy = "Havuzlu villa <harika> & sessiz\nDenize 200 m.\n\nİkinci paragraf";
    const html = plainTextToHtml(legacy);
    expect(html).toBe(
      "<p>Havuzlu villa &lt;harika&gt; &amp; sessiz<br />Denize 200 m.</p><p>İkinci paragraf</p>",
    );
    expect(sanitizeDescription(html)).toEqual({ html, text: legacy });
  });

  it("form doğrulaması: düz metin 5000, HTML 20000 sınırı", () => {
    expect(propertyInput.parse({ ...base, description: "<p>a</p>" }).description).toEqual({
      html: "<p>a</p>",
      text: "a",
    });
    expect(propertyInput.parse({ ...base, description: "" }).description).toBeUndefined();
    expect(errorsOf({ description: `<p>${"a".repeat(5001)}</p>` })).toEqual({
      description: "Açıklama en fazla 5000 karakter olabilir.",
    });
    expect(errorsOf({ description: "<p><strong>a</strong></p>".repeat(900) })).toEqual({
      description: "Açıklamada çok fazla biçimlendirme var.",
    });
  });
});

describe("belge numarası", () => {
  it("isteğe bağlı; boşluk kırpılır; harf, rakam, - / . kabul edilir", () => {
    expect(propertyInput.parse(base).tourismLicenseNo).toBeUndefined();
    expect(
      propertyInput.parse({ ...base, tourismLicenseNo: "  " }).tourismLicenseNo,
    ).toBeUndefined();
    expect(
      propertyInput.parse({ ...base, tourismLicenseNo: " 07-2023/1234.A " }).tourismLicenseNo,
    ).toBe("07-2023/1234.A");
    expect(propertyInput.parse({ ...base, tourismLicenseNo: "Ğİ 12" }).tourismLicenseNo).toBe(
      "Ğİ 12",
    );
    expect(errorsOf({ tourismLicenseNo: "<script>" })).toHaveProperty("tourismLicenseNo");
    expect(errorsOf({ tourismLicenseNo: "-12" })).toHaveProperty("tourismLicenseNo");
    expect(errorsOf({ tourismLicenseNo: "1".repeat(41) })).toEqual({
      tourismLicenseNo: "Belge numarası en fazla 40 karakter olabilir.",
    });
  });
});

describe("havuz bilgileri", () => {
  it("hiçbiri seçilmezse havuz yok (zorunlu değil)", () => {
    const v = propertyInput.parse(base);
    expect(poolsFromRaw(v)).toEqual({
      swimming: { present: false, depth: null, width: null, length: null },
      indoor: { present: false, depth: null, width: null, length: null },
      kids: { present: false, depth: null, width: null, length: null },
      swimmingProtected: false,
    });
  });

  it("var: ölçüler virgüllü/noktalı ondalık kabul edilir; korunaklı yalnız yüzme havuzunda", () => {
    const v = propertyInput.parse({
      ...base,
      poolSwimming: "yes",
      poolSwimmingDepth: "1,50",
      poolSwimmingWidth: "4",
      poolSwimmingLength: "8.25",
      poolSwimmingProtected: "yes",
      poolKids: "yes",
      poolKidsDepth: "0,4",
      poolKidsWidth: "2",
      poolKidsLength: "3",
    });
    expect(poolsFromRaw(v)).toEqual({
      swimming: { present: true, depth: 1.5, width: 4, length: 8.25 },
      indoor: { present: false, depth: null, width: null, length: null },
      kids: { present: true, depth: 0.4, width: 2, length: 3 },
      swimmingProtected: true,
    });
  });

  it("yok: girilmiş ölçüler ve korunaklı seçimi yok sayılır", () => {
    const v = propertyInput.parse({
      ...base,
      poolSwimming: "no",
      poolSwimmingDepth: "abc",
      poolSwimmingProtected: "yes",
      poolIndoor: "no",
      poolIndoorDepth: "1,2",
    });
    const p = poolsFromRaw(v);
    expect(p.swimming).toEqual({ present: false, depth: null, width: null, length: null });
    expect(p.indoor.depth).toBeNull();
    expect(p.swimmingProtected).toBe(false);
  });

  it("var + boş / geçersiz / aralık dışı ölçü: alan düzeyinde hata", () => {
    expect(errorsOf({ poolIndoor: "yes" })).toEqual({
      poolIndoorDepth: "Derinlik gerekli.",
      poolIndoorWidth: "Genişlik gerekli.",
      poolIndoorLength: "Uzunluk gerekli.",
    });
    expect(
      errorsOf({
        poolKids: "yes",
        poolKidsDepth: "1,505",
        poolKidsWidth: "0,2",
        poolKidsLength: "1e2",
      }),
    ).toEqual({
      poolKidsDepth: "Derinlik metre cinsinden, en fazla 2 ondalıklı bir sayı olmalı (ör. 1,50).",
      poolKidsWidth: "Genişlik 0,5 ile 100 m arasında olmalı.",
      poolKidsLength: "Uzunluk metre cinsinden, en fazla 2 ondalıklı bir sayı olmalı (ör. 1,50).",
    });
    expect(
      errorsOf({
        poolSwimming: "yes",
        poolSwimmingDepth: "11",
        poolSwimmingWidth: "4",
        poolSwimmingLength: "8",
      }),
    ).toEqual({
      poolSwimmingDepth: "Derinlik 0,1 ile 10 m arasında olmalı.",
    });
  });

  it("havuz hataları diğer alan hatalarıyla birlikte tek seferde gösterilir", () => {
    const e = errorsOf({ name: "", poolKids: "yes" });
    expect(Object.keys(e).sort()).toEqual([
      "name",
      "poolKidsDepth",
      "poolKidsLength",
      "poolKidsWidth",
    ]);
  });
});
