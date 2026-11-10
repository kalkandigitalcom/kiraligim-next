/**
 * Watchdog yeniden başlatma geçmişi: watchdog'un kontrollü çıkışlarının zamanları, oturum
 * klasörünün YANINDA küçük bir JSON dosyasında (<oturum klasörü>.watchdog.json; konteynerde
 * /app/.wa-auth.watchdog.json — volume dışında, Docker yeniden başlatmasında korunur). Oturum
 * klasörüne ve dosyalarına DOKUNULMAZ. Dosya okunamazsa geçmiş boş sayılır (en kısa pencere).
 */
import fs from "node:fs";

const MAX_ENTRIES = 20;

export class RestartHistory {
  constructor(private readonly file: string) {}

  read(): number[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { exits?: unknown };
      return Array.isArray(raw.exits)
        ? raw.exits.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
        : [];
    } catch {
      return [];
    }
  }

  /** Atomik yazım: geçici dosya + rename. */
  private write(exits: number[]) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ exits: exits.slice(-MAX_ENTRIES) }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  record(at: number) {
    try {
      this.write([...this.read(), at]);
    } catch {
      /* yazılamazsa pencere kısa kalır; çıkış yine yapılır */
    }
  }

  clear() {
    try {
      if (this.read().length > 0) this.write([]);
    } catch {
      /* önemsiz */
    }
  }
}
