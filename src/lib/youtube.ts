/**
 * YouTube video bağlantıları. Bağımlılıksız (form ve sunucu ortak). Yalnız video kimliği
 * (11 karakter) saklanır; gösterim için standart izleme adresi üretilir. Başka alan adları,
 * kanal / oynatma listesi / arama sayfaları kabul edilmez.
 */
const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
]);

export const isYouTubeId = (v: string) => ID.test(v);

/** Geçerli bir YouTube video bağlantısıysa video kimliği, değilse null. */
export function parseYouTubeId(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > 300) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  let id: string | null | undefined;
  if (host === "youtu.be") id = parts.length === 1 ? parts[0] : null;
  else if (parts[0] === "watch" && parts.length === 1) id = url.searchParams.get("v");
  else if (["shorts", "embed", "live", "v"].includes(parts[0] ?? "") && parts.length === 2)
    id = parts[1];
  return id && ID.test(id) ? id : null;
}

export const youtubeWatchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
