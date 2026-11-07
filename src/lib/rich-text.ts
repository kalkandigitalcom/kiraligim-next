/**
 * Açıklama yardımcıları (bağımlılıksız; tarayıcı ve sunucu). Biçimlendirme öncesi kaydedilmiş
 * düz metin açıklamalar, düzenleyicide ve gösterimde bu fonksiyonla HTML'e çevrilir.
 */
export const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Düz metin → güvenli HTML: boş satırla ayrılan bloklar paragraf, tek satır sonu <br>. */
export function plainTextToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br />")}</p>`)
    .join("");
}
