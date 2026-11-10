/**
 * Bağlantı ve güvenlik kuralları (saf, test edilebilir).
 */
import { DisconnectReason } from "baileys";

/**
 * Yeniden bağlanma zamanlaması (ms). Testlerde küçültülür.
 *  - backoffBase/backoffCap: "full jitter" üstel bekleme: rastgele(0, min(cap, base × 2^deneme)).
 *  - unavailableBase: WhatsApp hizmet dışı (503) için en kısa bekleme.
 *  - replacedCooldown: başka kopya oturumu açtığında (440) beklenecek süre aralığı.
 */
export type ReconnectTiming = {
  backoffBaseMs: number;
  backoffCapMs: number;
  unavailableBaseMs: number;
  replacedCooldownMinMs: number;
  replacedCooldownMaxMs: number;
};

export const DEFAULT_TIMING: ReconnectTiming = {
  backoffBaseMs: 2_000,
  backoffCapMs: 120_000,
  unavailableBaseMs: 30_000,
  replacedCooldownMinMs: 120_000,
  replacedCooldownMaxMs: 300_000,
};

/** 440 bu pencerede bu kadar tekrarlanırsa durulur (iki kopya birbirini düşürmesin). */
export const REPLACED_WINDOW_MS = 30 * 60_000;
export const REPLACED_MAX = 3;
/** Arka arkaya bu kadar 500 (bozuk oturum / kodsuz akış hatası) sonrası "degraded" uyarısı. */
export const BAD_SESSION_WARN = 5;

/** İnsan müdahalesi gerektiren durma durumları. Hiçbiri oturum dosyalarını SİLMEZ. */
export type HaltState = "needs_qr" | "blocked" | "replaced";

export type CloseDecision =
  | {
      action: "reconnect";
      delayMs: number;
      reason: string;
      /** Deneme sayacını artırır mı (515 artırmaz). */
      countsAttempt: boolean;
      /** Heartbeat'e yazılan kısa kod (ör. close_428). */
      code: string;
      degraded?: boolean;
    }
  | { action: "halt"; state: HaltState; reason: string; code: string };

/** Full jitter: [0, min(cap, base × 2^attempt)] aralığında; rnd ∈ [0, 1). */
export function backoffDelay(attempt: number, baseMs: number, capMs: number, rnd: number): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(Math.max(attempt, 0), 20));
  return Math.floor(Math.min(Math.max(rnd, 0), 0.999_999) * ceiling);
}

/**
 * Bağlantı kapandığında ne yapılacağı (saf). Kurtarılabilir her kapanma jitter'lı beklemeyle
 * yeniden denenir; yalnız insan müdahalesi gerektirenler durur ve HİÇBİRİ oturumu silmez:
 *  - 515 restartRequired: hemen (QR sonrası normal);
 *  - 503 unavailableService: en az unavailableBase;
 *  - 500 badSession: Baileys kodsuz akış hatalarını ("stream errored out") da 500 bildirir;
 *    çoğu geçicidir → yeniden dene, art arda BAD_SESSION_WARN kez olursa "degraded" uyarısı;
 *  - 440 connectionReplaced: bekle (2–5 dk) ve yeniden dene; 30 dk'da 3. kez → durur (replaced);
 *  - 401 loggedOut, 411 multideviceMismatch: durur (needs_qr), oturum SİLİNMEZ;
 *  - 403 forbidden: durur (blocked);
 *  - diğerleri (408, 428, kodsuz…): jitter'lı bekleme.
 */
export function decideClose(
  statusCode: number | undefined,
  ctx: {
    attempt: number;
    /** Önceki 440'ların zamanları (ms). */
    replacedAt: readonly number[];
    /** Art arda 500 sayısı (bu dahil değil). */
    badSessionStreak: number;
    now: number;
    rnd: number;
    timing?: ReconnectTiming;
  },
): CloseDecision {
  const t = ctx.timing ?? DEFAULT_TIMING;
  const code = `close_${statusCode ?? "none"}`;
  const jittered = (base: number) => backoffDelay(ctx.attempt, base, t.backoffCapMs, ctx.rnd);
  switch (statusCode) {
    case DisconnectReason.loggedOut:
      return {
        action: "halt",
        state: "needs_qr",
        reason: "Oturum kapatıldı (401); yeniden QR gerekir. Oturum dosyaları korunuyor.",
        code: "needs_qr_401",
      };
    case DisconnectReason.multideviceMismatch:
      return {
        action: "halt",
        state: "needs_qr",
        reason: "Çoklu cihaz uyumsuzluğu (411); yeniden QR gerekir. Oturum dosyaları korunuyor.",
        code: "needs_qr_411",
      };
    case DisconnectReason.forbidden:
      return {
        action: "halt",
        state: "blocked",
        reason: "Hesap erişimi reddedildi (403).",
        code: "blocked_403",
      };
    case DisconnectReason.connectionReplaced: {
      const recent = ctx.replacedAt.filter((at) => ctx.now - at < REPLACED_WINDOW_MS).length;
      if (recent + 1 >= REPLACED_MAX) {
        return {
          action: "halt",
          state: "replaced",
          reason: `Aynı oturum başka bir yerde açıldı (440, 30 dk içinde ${recent + 1}. kez); bu kopya durdu.`,
          code: "replaced_440",
        };
      }
      const span = t.replacedCooldownMaxMs - t.replacedCooldownMinMs;
      return {
        action: "reconnect",
        delayMs:
          t.replacedCooldownMinMs + Math.floor(Math.min(Math.max(ctx.rnd, 0), 0.999_999) * span),
        reason: "Aynı oturum başka bir yerde açıldı (440); bekleyip yeniden denenecek.",
        countsAttempt: true,
        code,
      };
    }
    case DisconnectReason.restartRequired:
      return {
        action: "reconnect",
        delayMs: 0,
        reason: "Yeniden başlatma istendi (515).",
        countsAttempt: false,
        code,
      };
    case DisconnectReason.unavailableService:
      return {
        action: "reconnect",
        delayMs: Math.max(t.unavailableBaseMs, jittered(t.unavailableBaseMs)),
        reason: "WhatsApp hizmet dışı (503).",
        countsAttempt: true,
        code,
      };
    case DisconnectReason.badSession: {
      const degraded = ctx.badSessionStreak + 1 >= BAD_SESSION_WARN;
      return {
        action: "reconnect",
        delayMs: jittered(t.backoffBaseMs),
        reason: degraded
          ? `Akış/oturum hatası (500) art arda ${ctx.badSessionStreak + 1}. kez; yeniden deneniyor.`
          : "Akış/oturum hatası (500); yeniden deneniyor.",
        countsAttempt: true,
        code,
        ...(degraded ? { degraded: true } : {}),
      };
    }
    default:
      return {
        action: "reconnect",
        delayMs: jittered(t.backoffBaseMs),
        reason: `Bağlantı koptu (${statusCode ?? "kod yok"}).`,
        countsAttempt: true,
        code,
      };
  }
}

/**
 * Watchdog penceresi (yeniden başlatma döngüsüne karşı üstel): son 6 saatteki watchdog çıkışı
 * sayısına göre 10, 20, 40, 60 dk (en fazla). Bağlantı bu süre boyunca kurulamazsa süreç
 * kontrollü olarak sıfırdan farklı kodla çıkar; Docker yeniden başlatır.
 */
export const WATCHDOG_BASE_MS = 10 * 60_000;
export const WATCHDOG_MAX_MS = 60 * 60_000;
export const WATCHDOG_HISTORY_MS = 6 * 60 * 60_000;
export function watchdogWindowMs(recentExits: readonly number[], now: number): number {
  const n = recentExits.filter((at) => now - at < WATCHDOG_HISTORY_MS && at <= now).length;
  return Math.min(WATCHDOG_MAX_MS, WATCHDOG_BASE_MS * 2 ** Math.min(n, 10));
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
  /** Şu an alınabilecek hak sayısı (hak tüketmez). */
  remaining(now = Date.now()): number {
    while (this.hits.length && now - this.hits[0]! >= this.windowMs) this.hits.shift();
    return Math.max(0, this.max - this.hits.length);
  }
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
  has(id: string): boolean {
    return this.set.has(id);
  }
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
