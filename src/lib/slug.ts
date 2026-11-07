/**
 * İşletme adından adres (slug) önerisi. Kurallar veritabanı kısıtıyla aynıdır:
 * 3–48 karakter, küçük harf/rakam/tire, tire ile başlamaz ve bitmez.
 * Yalnız öneri üretir; asıl doğrulama sunucuda (createWorkspaceInput) ve veritabanındadır.
 */
const TR_MAP: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  ö: "o",
  ş: "s",
  ü: "u",
  â: "a",
  î: "i",
  û: "u",
};

export const SLUG_MAX = 48;

export function slugify(input: string): string {
  const lower = input.toLocaleLowerCase("tr-TR");
  const mapped = Array.from(lower)
    .map((ch) => TR_MAP[ch] ?? ch)
    .join("")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
  return mapped
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
}
