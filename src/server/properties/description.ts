import sanitizeHtml from "sanitize-html";

/**
 * Mülk açıklaması (biçimlendirilmiş). Tarayıcıdaki düzenleyiciden gelen HTML'e GÜVENİLMEZ:
 * yalnız p, br, strong, em, u ve a (http/https/mailto) kalır; diğer her şey (script, style,
 * olay öznitelikleri, iframe, img, javascript:/data: bağlantıları, satır içi stil...) atılır.
 * Bağlantılar her zaman yeni sekmede ve rel="noopener noreferrer nofollow" ile açılır.
 * Kaydedilen her açıklama bu fonksiyondan geçer; gösterim yalnız bu çıktıyı kullanır.
 */

const LINK_SCHEMES = ["http:", "https:", "mailto:"];

function safeHref(href: string | undefined): string | null {
  if (!href) return null;
  const v = href.trim();
  if (v.length > 2000) return null;
  try {
    const u = new URL(v);
    if (!LINK_SCHEMES.includes(u.protocol)) return null;
    if (u.protocol !== "mailto:" && !u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["p", "br", "strong", "em", "u", "a"],
  allowedAttributes: { a: ["href", "target", "rel"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  // İçeriği de atılan etiketler (metin olarak bile kalmaz).
  nonTextTags: [
    "script",
    "style",
    "textarea",
    "option",
    "noscript",
    "template",
    "iframe",
    "object",
  ],
  transformTags: {
    b: "strong",
    i: "em",
    div: "p",
    h1: "p",
    h2: "p",
    h3: "p",
    h4: "p",
    h5: "p",
    h6: "p",
    li: "p",
    a: (_tag, attribs) => {
      const href = safeHref(attribs.href);
      // Geçersiz bağlantı: etiket kalkar, metni kalır (span izinli değil → atılır).
      if (!href) return { tagName: "span", attribs: {} as Record<string, string> };
      return {
        tagName: "a",
        attribs: { href, target: "_blank", rel: "noopener noreferrer nofollow" },
      };
    },
  },
  exclusiveFilter: (frame) => frame.tag === "a" && !frame.text.trim(),
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Temiz HTML → düz metin (paragraf ve satır sonları korunur). */
export function descriptionText(cleanHtml: string): string {
  const withBreaks = cleanHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n");
  const text = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} });
  return decodeEntities(text)
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type CleanDescription = { html: string; text: string };

/** Düzenleyiciden gelen HTML'i temizler. Görünür metin yoksa undefined (açıklama yok). */
export function sanitizeDescription(input: string): CleanDescription | undefined {
  const html = sanitizeHtml(input, OPTIONS)
    .replace(/<p>(\s|&nbsp;|<br \/>)*<\/p>/g, "")
    .trim();
  const text = descriptionText(html);
  if (!text) return undefined;
  return { html, text };
}
