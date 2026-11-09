/**
 * Tek kopya kilidi: aynı oturumu iki süreç açarsa WhatsApp ikisini de düşürür. Kilit dosyası
 * (<oturum klasörü>.lock) çalışan sürecin PID'ini tutar.
 */
import fs from "node:fs";

/**
 * Kilitteki süreç hâlâ çalışıyor mu? Kilit bu sürecin kendi PID'ini taşıyorsa eski bir kilittir:
 * konteyner yeniden başlatıldığında yeni süreç çoğu zaman yine PID 1 olur ve önceki çalışmadan
 * kalan "1" kendisi sanılırdı (sonsuz yeniden başlama döngüsü).
 */
export function lockHolderAlive(
  pid: number,
  self: number = process.pid,
  probe: (pid: number) => void = (p) => process.kill(p, 0),
): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === self) return false;
  try {
    probe(pid);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(lockPath: string): () => void {
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch {
    const pid = Number(fs.readFileSync(lockPath, "utf8"));
    if (lockHolderAlive(pid))
      throw new Error(`Başka bir kopya çalışıyor (pid ${pid}). Önce onu durdurun.`);
    fs.writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
  }
  return () => {
    try {
      if (fs.readFileSync(lockPath, "utf8") === String(process.pid)) fs.unlinkSync(lockPath);
    } catch {
      /* zaten yok */
    }
  };
}
