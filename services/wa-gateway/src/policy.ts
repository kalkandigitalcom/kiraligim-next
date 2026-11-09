/**
 * Bağlantı ve güvenlik kuralları (saf, test edilebilir).
 */
import { DisconnectReason } from "baileys";

export type ReconnectDecision =
  | { action: "reconnect"; delayMs: number; reason: string }
  | { action: "stop"; reason: string; resetAuth: boolean };

/**
 * Bağlantı kapandığında ne yapılacağı.
 *  - Oturum kapatıldı (telefondan "çıkış" ya da hesap engeli): durur, anahtarlar geçersiz.
 *  - Başka bir istemci aynı oturumu açtı: durur (iki kopya oturumu bozar).
 *  - Yeniden başlatma isteniyor (QR okutulduktan hemen sonra normal): hemen bağlanır.
 *  - Diğerleri (ağ, zaman aşımı, sunucu): artan bekleme ile, en fazla 60 sn.
 */
export function decideReconnect(
  statusCode: number | undefined,
  attempt: number,
): ReconnectDecision {
  switch (statusCode) {
    case DisconnectReason.loggedOut:
      return { action: "stop", reason: "Oturum kapatıldı; yeniden QR gerekir.", resetAuth: true };
    case DisconnectReason.forbidden:
      return { action: "stop", reason: "Hesap erişimi reddedildi (403).", resetAuth: false };
    case DisconnectReason.connectionReplaced:
      return {
        action: "stop",
        reason: "Aynı oturum başka bir yerde açıldı; bu kopya durdu.",
        resetAuth: false,
      };
    case DisconnectReason.multideviceMismatch:
      return {
        action: "stop",
        reason: "Çoklu cihaz uyumsuzluğu; yeniden QR gerekir.",
        resetAuth: true,
      };
    case DisconnectReason.badSession:
      return {
        action: "stop",
        reason: "Oturum dosyası bozuk; sıfırlayıp yeniden QR okutun.",
        resetAuth: false,
      };
    case DisconnectReason.restartRequired:
      return { action: "reconnect", delayMs: 0, reason: "Yeniden başlatma istendi." };
    default: {
      const base = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
      return {
        action: "reconnect",
        delayMs: base,
        reason: `Bağlantı koptu (${statusCode ?? "kod yok"}).`,
      };
    }
  }
}

/** Bağlanan hesap test numarası mı? `sock.user.id` örn. "905321112233:7@s.whatsapp.net". */
export function isAllowedAccount(userId: string | undefined, testNumber: string): boolean {
  if (!userId) return false;
  const user = userId.split("@")[0]?.split(":")[0] ?? "";
  return user === testNumber;
}

/** Kayan pencereli basit hız sınırı (ör. dakikada en fazla 10 tepki). */
export class RateLimiter {
  private readonly hits: number[] = [];
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  tryTake(now = Date.now()): boolean {
    while (this.hits.length && now - this.hits[0]! >= this.windowMs) this.hits.shift();
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

/** Aynı mesajın ikinci kez işlenmesini önler (bellekte, sınırlı boyut). */
export class SeenSet {
  private readonly set = new Set<string>();
  constructor(private readonly limit = 5_000) {}
  /** İlk kez görülüyorsa true. */
  add(id: string): boolean {
    if (this.set.has(id)) return false;
    this.set.add(id);
    if (this.set.size > this.limit) {
      const first = this.set.values().next().value;
      if (first !== undefined) this.set.delete(first);
    }
    return true;
  }
}
