/**
 * WhatsApp bağlı cihaz oturumu (Baileys).
 *  - Yalnız WA_ALLOWED_NUMBER hesabı: başka hesap bağlanırsa oturum hemen kapatılır, o yeni
 *    oturumun anahtarları silinir (tek otomatik silme budur).
 *  - Bu modülde metin mesajı gönderen kod YOKTUR; tek dışa yazım emoji tepkisidir.
 *  - QR ve oturum anahtarları günlüğe yazılmaz; QR yalnız bellekte tutulur, yerel arayüzde gösterilir.
 *
 * Bağlantı yönetimi (Aşama 1 — kendini kurtaran bağlantı):
 *  - Durum makinesi: starting → lease_wait → connecting → (qr) → open ⇄ backoff; durma durumları
 *    needs_qr (401/411), blocked (403), replaced (440 tekrarı), stopped. Durma durumlarında oturum
 *    dosyaları SİLİNMEZ.
 *  - Tek uçuş: aynı anda en fazla bir bağlantı kurulumu ve bir canlı soket; her sokete "kuşak"
 *    numarası verilir, eski soketin olayları yok sayılır ve dinleyicileri kaldırılır.
 *  - Bağlantı kurulumunun her adımı zaman aşımlıdır; hata her zaman yeni bir deneme planlar
 *    (sessizce takılı kalma yok). Bekleme: full jitter.
 *  - Tek kopya: PostgreSQL advisory lock (lease.ts) alınmadan WhatsApp'a bağlanılmaz.
 *  - Watchdog: kurtarılabilir bir durumda bağlantı 10 dk (yeniden başlatma döngüsünde 20, 40,
 *    60 dk) kurulamazsa süreç kontrollü olarak sıfırdan farklı kodla çıkar; Docker yeniden başlatır.
 *  - Protokol sürümü sabit: kurulu Baileys'in değeri (veya WA_PROTOCOL_VERSION); GitHub'dan çekilmez.
 *
 * A1 biçimi (veritabanı tanımlı): grupları keşfedip kaydeder (asistanı ekleyen kişi ve grup kurucusu
 * numaralarıyla; veritabanı yalnız özetini saklar), yalnız bağlı grupların metin mesajlarını kaydeder
 * (tekil), saatte bir saklama süresini uygular. Veritabanına yazılamayan mesaj sessizce kaybolmaz:
 * yeniden denenir, sonra bellekte bekletilip düzenli olarak yeniden gönderilir. Gruplara kod
 * YAZILMAZ: kullanıcı numarasını bir kez asistana ÖZEL mesajla doğrular (başarıda o mesaja ✅).
 * Mesaj içeriği ve numara günlüğe yazılmaz. Takvim, fiyat veya rezervasyon işlemi YOKTUR.
 *
 * Faz 1 test biçimi (veritabanı yok): test grubunun mesajını konsola yazar, tepki bırakır.
 */
import fs from "node:fs/promises";
import path from "node:path";

import makeWASocket, {
  Browsers,
  DEFAULT_CONNECTION_CONFIG,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  type AuthenticationState,
  type WAMessage,
  type WASocket,
} from "baileys";

import { authDirProblem, type Config } from "./config.ts";
import { MessageDiagnostics } from "./diagnostics.ts";
import {
  explainDirectMessage,
  explainGroupMessage,
  type InboundGroupMessage,
  istanbulTime,
  maskNumber,
  numberFromJid,
} from "./extract.ts";
import {
  groupPeople,
  type GroupMetaLike,
  parseVerifyMessage,
  personOf,
  selfAdded,
  selfIds,
  selfRemoved,
  toGroupSync,
} from "./groups.ts";
import { type Lease, NoopLease } from "./lease.ts";
import { createSafeLogger } from "./logger.ts";
import {
  backoffDelay,
  decideClose,
  DEFAULT_TIMING,
  isAllowedAccount,
  RateLimiter,
  type ReconnectTiming,
  SeenSet,
  watchdogWindowMs,
} from "./policy.ts";
import type {
  ConnectionStatus,
  InboundRecord,
  IngestOutcome,
  QueuedReaction,
  WaStore,
} from "./store.ts";
import type { RestartHistory } from "./watchdog.ts";

/** Saklama süresi (gün); src/lib/whatsapp-meta.ts WA_RETENTION_DAYS ile aynı. */
export const RETENTION_DAYS = 90;
/** Tek dışa yazım: başarılı numara doğrulama mesajına tepki. */
const VERIFY_REACTION = "✅";
/** Watchdog'un kontrollü çıkış kodu (Docker restart politikası yeniden başlatır). */
export const WATCHDOG_EXIT_CODE = 3;

export type GatewayStatus =
  | "starting"
  /** Tek kopya kilidi bekleniyor (başka bir gateway oturumu tutuyor). */
  | "lease_wait"
  | "connecting"
  /** İlk eşleştirme: QR okutulmayı bekliyor (oturum hiç kurulmamış). */
  | "qr"
  | "open"
  /** Bağlantı koptu; jitter'lı beklemeden sonra yeniden denenecek. */
  | "backoff"
  /** Oturum kapatıldı (401/411); yeniden QR gerekir. Oturum dosyaları korunur. */
  | "needs_qr"
  /** Hesap erişimi reddedildi (403). */
  | "blocked"
  /** Aynı oturum başka bir yerde tekrar tekrar açıldı (440). */
  | "replaced"
  | "stopped";

/** Kendiliğinden ilerleyen (watchdog'un izlediği) durumlar. */
const RECOVERABLE: ReadonlySet<GatewayStatus> = new Set(["starting", "connecting", "backoff"]);

export type GatewayEvent = {
  at: string;
  kind: "info" | "error" | "message" | "reaction";
  text: string;
};

export type SeenGroup = {
  jid: string;
  subject: string | null;
  lastAt: string;
  count: number;
  /** A1: veritabanındaki durum (discovered / linked / suspended / left). */
  dbStatus?: string;
};

export type GatewayStats = {
  stored: number;
  duplicate: number;
  ignored: number;
  /** Doğrulanan numara sayısı (özel mesajla gelen kod). */
  verified: number;
  rejectedCodes: number;
  errors: number;
  /** Veritabanına ilk denemede yazılamayıp yeniden denenen mesajlar. */
  ingestRetried: number;
  /** Bellek kuyruğu dolduğu için düşürülen mesajlar (yüksek sesle günlüğe yazılır). */
  ingestDropped: number;
  /** Çözülemeyen (CIPHERTEXT) mesaj yer tutucuları; içerik yok, yalnız sayı. */
  undecryptable: number;
  reconnects: number;
  /** A2f: işlem sonucu tepkileri (kuyruktan): gönderilen / gönderilemeyen. */
  reactionsSent: number;
  reactionsFailed: number;
};

export type HealthSnapshot = {
  /** Sağlık kontrolü sonucu: gerçek WhatsApp bağlantısını yansıtır. */
  ok: boolean;
  status: GatewayStatus;
  connected: boolean;
  /** İnsan müdahalesi gerekiyor (QR, engel, çift kopya). */
  attention: boolean;
  /** Bağlantı kaç saniyedir açık değil (açıksa null). */
  notOpenSec: number | null;
  pendingMessages: number;
};

/** Zamanlamalar (ms); testlerde küçültülür. */
export type GatewayTiming = ReconnectTiming & {
  authTimeoutMs: number;
  leaseTimeoutMs: number;
  leaseRetryMs: number;
  /** Bağlantı bu kadar açık kalınca deneme sayacı sıfırlanır. */
  stableOpenMs: number;
  heartbeatMs: number;
  watchdogTickMs: number;
  /** Sağlık kontrolü: kurtarılabilir durumda bu süreden uzun açık değilse 503. */
  healthGraceMs: number;
  /** Veritabanına yazımda yeniden deneme beklemeleri. */
  ingestRetryMs: readonly number[];
  /** Bekleyen mesajların yeniden gönderim aralığı. */
  pendingRetryMs: number;
  pendingMax: number;
  /** Kapanışta bekleyen mesajlar için en fazla süre. */
  flushTimeoutMs: number;
  /** A2f: tepki kuyruğunu yoklama aralığı (yalnız bağlantı açıkken gönderilir). */
  reactionPollMs: number;
  /** Tek tepki gönderiminin süre sınırı. */
  reactionSendTimeoutMs: number;
};

export const DEFAULT_GATEWAY_TIMING: GatewayTiming = {
  ...DEFAULT_TIMING,
  authTimeoutMs: 15_000,
  leaseTimeoutMs: 15_000,
  leaseRetryMs: 30_000,
  stableOpenMs: 60_000,
  heartbeatMs: 60_000,
  watchdogTickMs: 30_000,
  healthGraceMs: 3 * 60_000,
  ingestRetryMs: [500, 2_000, 5_000],
  pendingRetryMs: 30_000,
  pendingMax: 2_000,
  flushTimeoutMs: 10_000,
  reactionPollMs: 5_000,
  reactionSendTimeoutMs: 15_000,
};

type SocketFactory = (opts: {
  auth: AuthenticationState;
  version: [number, number, number] | null;
}) => WASocket;
type AuthLoader = (
  dir: string,
) => Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }>;

export type GatewayDeps = {
  makeSocket?: SocketFactory;
  loadAuth?: AuthLoader;
  lease?: Lease;
  history?: RestartHistory;
  /** Watchdog süresi doldu: çağıran kontrollü kapanıp WATCHDOG_EXIT_CODE ile çıkar. */
  onWatchdog?: () => void;
  timing?: Partial<GatewayTiming>;
  now?: () => number;
  random?: () => number;
};

const MAX_EVENTS = 50;
/** Dinleyicisi kaldırılan Baileys olayları (eski soket yeni durumu etkilemesin). */
const SOCKET_EVENTS = [
  "creds.update",
  "connection.update",
  "messages.upsert",
  "messages.update",
  "groups.upsert",
  "groups.update",
  "group-participants.update",
] as const;

const withTimeout = <T>(p: Promise<T>, ms: number, code: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(code)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(code));
      },
    );
  });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type PendingIngest = { key: string; record: InboundRecord; firstAt: number };

export class WaGateway {
  status: GatewayStatus = "starting";
  reason: string | null = null;
  /** Ham QR yalnız bellekte; günlüğe yazılmaz. */
  qr: string | null = null;
  account: string | null = null;
  connectedAt: string | null = null;
  /** Son kapanma kodu (ör. close_428) veya bağlantı hata kodu; heartbeat ile yazılır. */
  lastCode: string | null = null;
  degraded = false;
  readonly events: GatewayEvent[] = [];
  readonly groups = new Map<string, SeenGroup>();
  readonly protocolVersion: string;

  private sock: WASocket | null = null;
  private generation = 0;
  private connecting: Promise<void> | null = null;
  private again = false;
  private attempt = 0;
  private badSessionStreak = 0;
  private readonly replacedAt: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private halted = false;
  /** Bağlantının açık olmadığı sürenin başı (açıkken null). */
  private notOpenSince: number;
  private openSince: number | null = null;
  private watchdogFired = false;
  private watchdogWindow: number;
  private readonly seen = new SeenSet();
  /** Aşama 1.1: mesaj alımı teşhisi (yalnız gözlem). */
  readonly diag: MessageDiagnostics;
  /** Güncel soketin ham WebSocket dinleyicilerini kaldırır. */
  private detachRaw: (() => void) | null = null;
  private readonly inFlight = new Set<string>();
  private readonly pending: PendingIngest[] = [];
  private flushing: Promise<void> | null = null;
  private readonly reactions = new RateLimiter(10, 60_000);
  private readonly pendingReactions = new Map<string, string>();
  private readonly logger = createSafeLogger();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;
  private reactionTimer: NodeJS.Timeout | null = null;
  private reactionFlushing: Promise<void> | null = null;
  private readonly t: GatewayTiming;
  private readonly now: () => number;
  private readonly rnd: () => number;
  private readonly lease: Lease;
  private readonly makeSocket: SocketFactory;
  private readonly loadAuth: AuthLoader;
  readonly stats: GatewayStats = {
    stored: 0,
    duplicate: 0,
    ignored: 0,
    verified: 0,
    rejectedCodes: 0,
    errors: 0,
    ingestRetried: 0,
    ingestDropped: 0,
    undecryptable: 0,
    reconnects: 0,
    reactionsSent: 0,
    reactionsFailed: 0,
  };

  constructor(
    private readonly config: Config,
    private readonly store: WaStore | null = null,
    private readonly deps: GatewayDeps = {},
  ) {
    this.t = { ...DEFAULT_GATEWAY_TIMING, ...deps.timing };
    this.now = deps.now ?? Date.now;
    this.rnd = deps.random ?? Math.random;
    this.lease = deps.lease ?? new NoopLease();
    this.loadAuth = deps.loadAuth ?? useMultiFileAuthState;
    this.makeSocket = deps.makeSocket ?? ((o) => this.defaultSocket(o));
    this.notOpenSince = this.now();
    this.diag = new MessageDiagnostics(this.now, config.trace);
    this.watchdogWindow = watchdogWindowMs(deps.history?.read() ?? [], this.now());
    const v = config.protocolVersion ?? DEFAULT_CONNECTION_CONFIG.version;
    this.protocolVersion = v.join(".");
    this.lease.onLost(() => this.onLeaseLost());
  }

  get mode(): "a1" | "test" {
    return this.store ? "a1" : "test";
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Watchdog penceresi (ms): yeniden başlatma döngüsünde uzar. */
  get watchdogWindowMs(): number {
    return this.watchdogWindow;
  }

  /** Veritabanı çağrısı; hata bağlantıyı düşürmez, yalnız sayılır ve kısa günlüğe yazılır. */
  private async db<T>(label: string, fn: (store: WaStore) => Promise<T>): Promise<T | null> {
    if (!this.store) return null;
    try {
      return await fn(this.store);
    } catch (e: unknown) {
      this.stats.errors += 1;
      this.note("error", `Veritabanı hatası (${label}): ${errName(e)}`);
      return null;
    }
  }

  /** Durum → veritabanı (wa_connections): durum ve kısa kod (numara/içerik yok). */
  private heartbeatArgs(): [ConnectionStatus, string | null] {
    switch (this.status) {
      case "open":
        return [
          "open",
          this.pending.length > 0 ? "ingest_backlog" : this.degraded ? "degraded" : null,
        ];
      case "starting":
      case "connecting":
        return ["connecting", this.lastCode];
      case "qr":
        return ["connecting", "qr_pairing"];
      case "needs_qr":
        return ["logged_out", this.lastCode ?? "needs_qr"];
      case "lease_wait":
        return ["closed", "lease_wait"];
      default:
        return ["closed", this.lastCode ?? this.status];
    }
  }

  private heartbeat() {
    // Tek kopya kilidi bizde değilse (başka kopya oturumu tutuyor ya da kilit kayboldu) bağlantı
    // satırına YAZILMAZ: aynı etiketli çalışan kopyanın "open" durumunu ezmesin.
    if (!this.lease.held) return;
    const [status, code] = this.heartbeatArgs();
    const accountPn = this.account;
    void this.db("heartbeat", (s) => s.heartbeat(status, code, accountPn));
  }

  private note(kind: GatewayEvent["kind"], text: string) {
    this.events.unshift({ at: new Date(this.now()).toISOString(), kind, text });
    this.events.length = Math.min(this.events.length, MAX_EVENTS);
    const line = `[wa] ${text}`;
    if (kind === "error") console.error(line);
    else console.log(line);
  }

  private setStatus(status: GatewayStatus, reason: string | null = this.reason) {
    const changed = status !== this.status;
    if (status === "open") {
      this.notOpenSince = Number.NaN;
    } else if (this.status === "open" || Number.isNaN(this.notOpenSince)) {
      this.notOpenSince = this.now();
    }
    this.status = status;
    this.reason = reason;
    if (changed) this.heartbeat();
  }

  /** Sağlık kontrolü için anlık durum (numara, grup, QR yok). */
  health(): HealthSnapshot {
    const now = this.now();
    const connected = this.status === "open";
    const notOpenMs = connected ? 0 : Math.max(0, now - this.notOpenSince);
    const notOpenSec = connected ? null : Math.round(notOpenMs / 1000);
    const attention =
      this.status === "qr" ||
      this.status === "needs_qr" ||
      this.status === "blocked" ||
      this.status === "replaced" ||
      this.status === "lease_wait" ||
      this.status === "stopped";
    let ok: boolean;
    if (connected) ok = true;
    // İlk eşleştirme (QR) beklenirken sağlıklı sayılır: yeni kurulum deploy'u düşmesin.
    else if (this.status === "qr") ok = true;
    else if (RECOVERABLE.has(this.status)) ok = notOpenMs < this.t.healthGraceMs;
    else ok = false;
    return {
      ok,
      status: this.status,
      connected,
      attention,
      notOpenSec,
      pendingMessages: this.pending.length,
    };
  }

  /** Oturum klasörü yalnız sahibine açık (0700); dosyalar Baileys tarafından yazılır. */
  private async ensureAuthDir() {
    await fs.mkdir(this.config.authDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.config.authDir, 0o700);
  }

  private defaultSocket(o: {
    auth: AuthenticationState;
    version: [number, number, number] | null;
  }) {
    return makeWASocket({
      auth: { creds: o.auth.creds, keys: makeCacheableSignalKeyStore(o.auth.keys, this.logger) },
      // Sabit sürüm: kurulu Baileys'in değeri (verilmezse) veya WA_PROTOCOL_VERSION.
      ...(o.version ? { version: o.version } : {}),
      logger: this.logger,
      browser: Browsers.macOS("Kiraligim Test"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldIgnoreJid: (jid) =>
        Boolean(isJidBroadcast(jid) || isJidNewsletter(jid) || isJidStatusBroadcast(jid)),
      getMessage: async () => undefined,
    });
  }

  /* ── Yaşam döngüsü ──────────────────────────────────────────────────── */

  async start(): Promise<void> {
    this.shuttingDown = false;
    this.halted = false;
    this.startTimers();
    await this.connect();
  }

  /** Tek uçuş: eşzamanlı çağrılar aynı kurulumu bekler. */
  private connect(): Promise<void> {
    if (this.connecting) {
      // Kurulum sürerken gelen istek kaybolmaz: kurulum canlı soket veya plan üretmeden biterse
      // (ör. kuşak değişti) hemen bir kez daha denenir.
      this.again = true;
      return this.connecting;
    }
    this.connecting = this.doConnect()
      .catch((e: unknown) => this.failConnect(errName(e), e))
      .finally(() => {
        this.connecting = null;
        if (this.again) {
          this.again = false;
          if (!this.shuttingDown && !this.halted && !this.sock && !this.timer) void this.connect();
        }
      });
    return this.connecting;
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number) {
    this.clearTimer();
    if (this.shuttingDown || this.halted) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delayMs);
  }

  /** Eski soketi kapatır ve dinleyicilerini kaldırır (yalnız bir canlı soket kalsın). */
  private teardownSocket() {
    const sock = this.sock;
    this.sock = null;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
    this.openSince = null;
    this.detachRaw?.();
    this.detachRaw = null;
    if (!sock) return;
    for (const ev of SOCKET_EVENTS) {
      try {
        sock.ev.removeAllListeners(ev);
      } catch {
        /* zaten kapalı */
      }
    }
    try {
      sock.end(undefined);
    } catch {
      /* zaten kapalı */
    }
  }

  /** Kurulum hatası: her zaman yeni deneme planlanır (sessizce takılı kalınmaz). */
  private failConnect(code: string, e?: unknown) {
    if (this.shuttingDown || this.halted) return;
    this.teardownSocket();
    this.lastCode = code;
    this.attempt += 1;
    const delay = backoffDelay(this.attempt, this.t.backoffBaseMs, this.t.backoffCapMs, this.rnd());
    const detail = e && errName(e) !== code ? `${code}: ${errName(e)}` : code;
    this.setStatus("backoff", `Bağlantı kurulamadı (${detail}).`);
    this.note(
      "error",
      `Bağlantı kurulamadı (${detail}); ${Math.round(delay / 1000)} sn sonra yeniden denenecek (deneme ${this.attempt}).`,
    );
    this.schedule(delay);
  }

  private async doConnect() {
    if (this.shuttingDown || this.halted) return;
    this.clearTimer();
    this.teardownSocket();
    const gen = ++this.generation;

    // 1. Tek kopya kilidi (alınmadan WhatsApp'a bağlanılmaz).
    if (!this.lease.held) {
      if (this.status !== "lease_wait") this.setStatus("lease_wait", "Tek kopya kilidi alınıyor.");
      let got: boolean;
      try {
        got = await withTimeout(this.lease.acquire(), this.t.leaseTimeoutMs, "lease_timeout");
      } catch (e: unknown) {
        if (gen === this.generation) this.failConnect("lease_error", e);
        return;
      }
      if (gen !== this.generation || this.shuttingDown) return;
      if (!got) {
        this.lastCode = "lease_wait";
        this.setStatus(
          "lease_wait",
          "Başka bir gateway kopyası bu oturumu tutuyor; bu kopya WhatsApp'a bağlanmıyor.",
        );
        this.note("error", "Tek kopya kilidi başka bir kopyada; bağlanılmadı, beklemede.");
        this.schedule(Math.round(this.t.leaseRetryMs * (0.5 + this.rnd())));
        return;
      }
    }

    // 2. Oturum anahtarları (zaman aşımlı).
    this.setStatus("connecting", this.reason);
    await this.ensureAuthDir();
    const auth = await withTimeout(
      this.loadAuth(this.config.authDir),
      this.t.authTimeoutMs,
      "auth_timeout",
    );
    if (gen !== this.generation || this.shuttingDown || this.halted) return;

    // 3. Soket (protokol sürümü sabit; ağdan çekilmez).
    const sock = this.makeSocket({ auth: auth.state, version: this.config.protocolVersion });
    this.sock = sock;
    this.diag.onSocket(gen);
    this.attach(sock, gen, auth.saveCreds);
  }

  private attach(sock: WASocket, gen: number, saveCreds: () => Promise<void>) {
    const live = () => gen === this.generation && sock === this.sock;
    this.attachRaw(sock, live);
    sock.ev.on("creds.update", () => {
      void saveCreds().catch((e: unknown) =>
        this.note("error", `Oturum bilgisi kaydedilemedi: ${errName(e)}`),
      );
    });

    sock.ev.on("connection.update", (u) => {
      if (!live()) return;
      if (u.qr) {
        this.qr = u.qr;
        this.lastCode = null;
        this.setStatus("qr", null);
        this.note("info", "QR hazır: test arayüzünden okutun (QR günlüğe yazılmaz).");
      }
      if (u.connection === "connecting" && this.status !== "qr") this.setStatus("connecting");
      if (u.receivedPendingNotifications) this.diag.onOfflineSynced();
      if (u.connection === "open") void this.onOpen(sock, gen);
      if (u.connection === "close") {
        const err = u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
        this.onClose(sock, gen, err?.output?.statusCode);
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      const ciphertext = proto.WebMessageInfo.StubType.CIPHERTEXT;
      this.diag.onUpsert(type, messages, live(), ciphertext);
      if (!live()) return;
      for (const msg of messages) {
        if (msg.messageStubType === ciphertext) {
          // Çözülemeyen mesaj: Baileys yeniden deneme ister; başarılı olursa aynı kimlikle tekrar gelir.
          this.stats.undecryptable += 1;
        }
      }
      // A1: kesinti sonrası birikim ("append") de kaydedilir ama "backlog" olarak işaretlenir.
      if (type !== "notify" && !(this.store && type === "append")) {
        this.diag.onSkippedType(type, messages.length);
        return;
      }
      for (const msg of messages) {
        if (this.store && !isJidGroup(msg.key?.remoteJid ?? "")) {
          void this.onDirectMessage(sock, msg);
        } else {
          void this.onMessage(sock, msg, type === "append");
        }
      }
    });

    if (this.store) {
      // Gruba katılım: bildirim meta verisi asistanı EKLEYEN kişiyi (author) içerir.
      sock.ev.on("groups.upsert", (metas) => {
        if (!live()) return;
        for (const meta of metas) void this.syncGroup(sock, meta);
      });
      sock.ev.on("groups.update", (updates) => {
        if (!live()) return;
        for (const u of updates) if (u.id) void this.refreshGroup(sock, u.id);
      });
      sock.ev.on("group-participants.update", (ev) => {
        if (!live()) return;
        const self = selfIds(sock.user);
        if (selfRemoved(ev.action, ev.participants, self)) {
          void this.markLeft(ev.id);
        } else if (selfAdded(ev.action, ev.participants, self)) {
          void this.refreshGroup(sock, ev.id, personOf(ev.author, ev.authorPn));
        } else {
          void this.refreshGroup(sock, ev.id);
        }
      });
    }

    sock.ev.on("messages.update", (updates) => {
      for (const { key, update } of updates) {
        const id = key.id ?? "";
        const label = this.pendingReactions.get(id);
        if (!label || update.status == null) continue;
        if (update.status >= proto.WebMessageInfo.Status.SERVER_ACK) {
          this.pendingReactions.delete(id);
          this.note("reaction", `Tepki sunucuya ulaştı (${label}).`);
        } else if (update.status === proto.WebMessageInfo.Status.ERROR) {
          this.pendingReactions.delete(id);
          this.note("error", `Tepki sunucu tarafından reddedildi (${label}).`);
        }
      }
    });
  }

  /**
   * Aşama 1.1: Baileys'ten ÖNCE, WebSocket'ten gelen ham "message" paketlerini yalnız sayar
   * (pasif dinleyici; Baileys'in işleyişini değiştirmez, paketin içeriğine bakılmaz).
   */
  private attachRaw(sock: WASocket, live: () => boolean) {
    type WsLike = {
      on(ev: string, fn: (...a: unknown[]) => void): unknown;
      off?(ev: string, fn: (...a: unknown[]) => void): unknown;
      removeListener?(ev: string, fn: (...a: unknown[]) => void): unknown;
    };
    const ws = (sock as unknown as { ws?: WsLike }).ws;
    if (!ws || typeof ws.on !== "function") return;
    // Teşhis kodu hiçbir koşulda Baileys'in paket işleyişini etkilememeli: hatalar yutulur.
    const safe =
      (fn: (node: unknown) => void) =>
      (node: unknown): void => {
        try {
          fn(node);
        } catch {
          /* yalnız gözlem */
        }
      };
    const onMessage = safe((node) =>
      this.diag.onRawMessage((node ?? {}) as { attrs?: Record<string, string> }, live()),
    );
    const onNotification = safe(() => this.diag.onRawNotification());
    const onFrame = safe(() => this.diag.onFrame());
    ws.on("CB:message", onMessage);
    ws.on("CB:notification", onNotification);
    ws.on("frame", onFrame);
    this.detachRaw = () => {
      const off = (ev: string, fn: (...a: unknown[]) => void) => {
        try {
          if (typeof ws.off === "function") ws.off(ev, fn);
          else ws.removeListener?.(ev, fn);
        } catch {
          /* soket kapalı */
        }
      };
      off("CB:message", onMessage);
      off("CB:notification", onNotification);
      off("frame", onFrame);
    };
  }

  private async onOpen(sock: WASocket, gen: number) {
    if (gen !== this.generation || sock !== this.sock) return;
    if (!isAllowedAccount(sock.user?.id, this.config.allowedNumber)) {
      this.note(
        "error",
        "İzin verilmeyen bir hesap bağlandı; oturum kapatılıyor ve bu yeni oturumun anahtarları siliniyor. Yalnız WA_ALLOWED_NUMBER kullanılabilir.",
      );
      this.halted = true;
      this.clearTimer();
      try {
        await sock.logout();
      } catch {
        /* bağlantı zaten kapanmış olabilir */
      }
      this.teardownSocket();
      await this.removeAuth();
      this.lastCode = "account_rejected";
      this.account = null;
      this.setStatus("stopped", "İzin verilmeyen hesap reddedildi.");
      return;
    }
    this.qr = null;
    this.lastCode = null;
    this.account = numberFromJid(sock.user?.id ?? null);
    this.connectedAt = new Date(this.now()).toISOString();
    this.openSince = this.now();
    this.diag.onOpen();
    this.setStatus("open", null);
    this.note("info", `Bağlandı: ${maskNumber(this.account)}.`);
    // Kısa süre açık kalıp düşen bağlantıda sayaç sıfırlanmaz ("açıl-hemen-düş" döngüsü yavaşlar).
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      if (gen !== this.generation || this.status !== "open") return;
      this.attempt = 0;
      this.badSessionStreak = 0;
      this.degraded = false;
    }, this.t.stableOpenMs);
    this.stableTimer.unref?.();
    if (this.store) {
      void this.flushPending();
      await this.syncAllGroups(sock);
      void this.flushReactions();
      return;
    }
    if (!this.config.testGroupJid) {
      this.note(
        "info",
        "WA_TEST_GROUP_JID tanımlı değil: tepki bırakılmayacak. Test grubuna bir mesaj yazın; grup kimliği arayüzde görünür.",
      );
    }
  }

  private onClose(sock: WASocket, gen: number, statusCode: number | undefined) {
    if (gen !== this.generation || sock !== this.sock) return;
    this.teardownSocket();
    if (this.shuttingDown || this.halted) return;
    const now = this.now();
    const decision = decideClose(statusCode, {
      attempt: this.attempt,
      replacedAt: this.replacedAt,
      badSessionStreak: this.badSessionStreak,
      now,
      rnd: this.rnd(),
      timing: this.t,
    });
    if (statusCode === 440) {
      this.replacedAt.push(now);
      while (this.replacedAt.length > 10) this.replacedAt.shift();
    }
    this.badSessionStreak = statusCode === 500 ? this.badSessionStreak + 1 : 0;
    this.lastCode = decision.code;
    this.qr = null;
    if (decision.action === "halt") {
      // Durma: oturum dosyaları SİLİNMEZ; insan müdahalesi gerekir (arayüz / panel).
      this.halted = true;
      this.clearTimer();
      this.setStatus(decision.state, decision.reason);
      this.note("error", `Bağlantı durdu: ${decision.reason}`);
      return;
    }
    if (decision.countsAttempt) this.attempt += 1;
    if (decision.degraded && !this.degraded) {
      this.degraded = true;
      this.note(
        "error",
        "Oturum art arda akış hatası veriyor (degraded); yeniden denenmeye devam ediliyor.",
      );
    }
    this.stats.reconnects += 1;
    this.setStatus("backoff", decision.reason);
    this.note(
      "info",
      `${decision.reason} ${Math.round(decision.delayMs / 1000)} sn sonra yeniden bağlanılacak (deneme ${this.attempt}).`,
    );
    this.schedule(decision.delayMs);
  }

  /** Tek kopya kilidi kaybedildi: WhatsApp soketi hemen kapatılır, kilit yeniden alınmadan bağlanılmaz. */
  private onLeaseLost() {
    if (this.shuttingDown) return;
    this.note(
      "error",
      "Tek kopya kilidi kaybedildi (veritabanı bağlantısı); WhatsApp soketi kapatılıyor.",
    );
    this.generation += 1;
    this.teardownSocket();
    if (this.halted) return;
    this.lastCode = "lease_lost";
    this.setStatus("lease_wait", "Tek kopya kilidi yeniden alınıyor.");
    this.schedule(Math.round(this.t.backoffBaseMs * (1 + this.rnd())));
  }

  /* ── Zamanlayıcılar: heartbeat, watchdog, saklama, bekleyen mesajlar ── */

  private startTimers() {
    if (!this.heartbeatTimer && this.store) {
      // Her durumda yazılır: panel "bağlı değil ama yaşıyor" ile "tamamen kapalı"yı ayırt eder.
      this.heartbeatTimer = setInterval(() => this.heartbeat(), this.t.heartbeatMs);
      this.heartbeatTimer.unref();
    }
    if (!this.watchdogTimer) {
      this.watchdogTimer = setInterval(() => this.watchdogTick(), this.t.watchdogTickMs);
      this.watchdogTimer.unref();
    }
    if (!this.pendingTimer && this.store) {
      this.pendingTimer = setInterval(() => void this.flushPending(), this.t.pendingRetryMs);
      this.pendingTimer.unref();
    }
    if (!this.purgeTimer && this.store) {
      const purge = () =>
        void this.db("purge", async (s) => {
          const n = await s.purge(RETENTION_DAYS);
          if (n > 0) this.note("info", `Saklama: ${n} eski mesaj silindi.`);
        });
      purge();
      this.purgeTimer = setInterval(purge, 60 * 60_000);
      this.purgeTimer.unref();
    }
    if (!this.reactionTimer && this.store) {
      this.reactionTimer = setInterval(() => void this.flushReactions(), this.t.reactionPollMs);
      this.reactionTimer.unref();
    }
  }

  private stopTimers() {
    for (const t of [
      this.heartbeatTimer,
      this.watchdogTimer,
      this.pendingTimer,
      this.purgeTimer,
      this.reactionTimer,
    ]) {
      if (t) clearInterval(t);
    }
    this.reactionTimer = null;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.heartbeatTimer = null;
    this.watchdogTimer = null;
    this.pendingTimer = null;
    this.purgeTimer = null;
    this.stableTimer = null;
  }

  /**
   * Watchdog: kurtarılabilir bir durumda bağlantı penceresi boyunca kurulamadıysa süreç kontrollü
   * çıkar (Docker yeniden başlatır). QR, engel, çift kopya ve kilit beklemesinde ÇALIŞMAZ
   * (yeniden başlatma bunları çözmez, döngü yaratır). Oturum dosyalarına dokunulmaz.
   * Bağlantı pencere boyunca açık kalırsa yeniden başlatma geçmişi temizlenir.
   */
  watchdogTick() {
    this.diag.checkStall((msg) => this.note("error", msg));
    const now = this.now();
    if (
      this.status === "open" &&
      this.openSince !== null &&
      now - this.openSince >= this.watchdogWindow
    ) {
      this.deps.history?.clear();
      return;
    }
    if (this.watchdogFired || this.shuttingDown || !RECOVERABLE.has(this.status)) return;
    if (Number.isNaN(this.notOpenSince) || now - this.notOpenSince < this.watchdogWindow) return;
    this.watchdogFired = true;
    this.lastCode = "watchdog_exit";
    this.note(
      "error",
      `Watchdog: bağlantı ${Math.round(this.watchdogWindow / 60_000)} dk boyunca kurulamadı; süreç yeniden başlatılmak üzere kontrollü olarak kapatılıyor (oturum korunur).`,
    );
    this.deps.history?.record(now);
    this.heartbeat();
    this.deps.onWatchdog?.();
  }

  private async groupSubject(sock: WASocket, jid: string): Promise<string | null> {
    const known = this.groups.get(jid);
    if (known?.subject) return known.subject;
    try {
      return (await sock.groupMetadata(jid)).subject ?? null;
    } catch {
      return null;
    }
  }

  /* ── A1: grup keşfi ─────────────────────────────────────────────────── */

  /** Kişinin numarası: biliniyorsa doğrudan, yalnız gizli kimlik (LID) varsa eşleme tablosundan. */
  private async resolvePn(
    sock: WASocket,
    person: { pn: string | null; lid: string | null },
  ): Promise<string | null> {
    if (person.pn || !person.lid) return person.pn;
    try {
      return numberFromJid(await sock.signalRepository.lidMapping.getPNForLID(person.lid));
    } catch {
      return null;
    }
  }

  private async syncGroup(
    sock: WASocket,
    meta: GroupMetaLike,
    present = true,
    addedBy?: { pn: string | null; lid: string | null },
  ) {
    const g = toGroupSync(meta, selfIds(sock.user));
    const people = groupPeople(meta);
    const [addedByPn, ownerPn] = await Promise.all([
      this.resolvePn(sock, addedBy ?? people.addedBy),
      this.resolvePn(sock, people.owner),
    ]);
    const status = await this.db("sync_group", (s) =>
      s.syncGroup({ ...g, present, addedByPn, ownerPn }),
    );
    const prev = this.groups.get(g.jid);
    this.groups.set(g.jid, {
      jid: g.jid,
      subject: g.subject,
      lastAt: prev?.lastAt ?? new Date().toISOString(),
      count: prev?.count ?? 0,
      ...(status ? { dbStatus: status } : {}),
    });
  }

  private async refreshGroup(
    sock: WASocket,
    jid: string,
    addedBy?: { pn: string | null; lid: string | null },
  ) {
    try {
      await this.syncGroup(sock, await sock.groupMetadata(jid), true, addedBy);
    } catch {
      /* grup meta verisi alınamadı (ör. gruptan çıkarıldı); bir sonraki olayda tekrar denenir */
    }
  }

  private async markLeft(jid: string) {
    const prev = this.groups.get(jid);
    const status = await this.db("sync_group", (s) =>
      s.syncGroup({
        jid,
        subject: prev?.subject ?? null,
        participants: 0,
        botIsAdmin: false,
        adminsOnly: false,
        present: false,
      }),
    );
    if (prev && status) prev.dbStatus = status;
    this.note("info", `Kiraligim bir gruptan çıkarıldı: ${jid}.`);
  }

  private async syncAllGroups(sock: WASocket) {
    try {
      const all = await sock.groupFetchAllParticipating();
      const metas = Object.values(all);
      for (const meta of metas) await this.syncGroup(sock, meta);
      this.note("info", `Grup keşfi: ${metas.length} grup kaydedildi/güncellendi.`);
    } catch (e: unknown) {
      this.note("error", `Grup listesi alınamadı: ${e instanceof Error ? e.name : "Error"}`);
    }
  }

  /* ── Mesajlar ───────────────────────────────────────────────────────── */

  private async resolveSender(sock: WASocket, m: InboundGroupMessage): Promise<string | null> {
    if (m.senderNumber || !m.senderLid) return m.senderNumber;
    try {
      return numberFromJid(await sock.signalRepository.lidMapping.getPNForLID(m.senderLid));
    } catch {
      return null;
    }
  }

  private async onMessage(sock: WASocket, msg: WAMessage, backlog = false) {
    const explained = explainGroupMessage(msg);
    if (!explained.ok) {
      this.diag.onGroupFiltered(
        msg.key?.remoteJid,
        msg.key?.id,
        explained.reason,
        explained.contentType,
      );
      return;
    }
    const m = explained.message;
    const key = `${m.groupJid}|${m.messageId}`;
    if (this.store) {
      // Aynı mesaj ikinci kez işlenmez: kaydedilmiş, şu an yazılıyor ya da kuyrukta bekliyor.
      // Kayıtlı sayılması YALNIZ veritabanı yazımı başarılı olunca (yazılamazsa kuyrukta bekler).
      if (this.seen.has(key) || this.inFlight.has(key) || this.pending.some((p) => p.key === key)) {
        this.diag.onGroupFiltered(m.groupJid, m.messageId, "duplicate");
        return;
      }
      this.diag.onGroupAccepted(m.groupJid, m.messageId);
      this.inFlight.add(key);
      try {
        await this.onA1Message(sock, msg, m, backlog, key);
      } finally {
        this.inFlight.delete(key);
      }
      return;
    }
    if (!this.seen.add(key)) {
      this.diag.onGroupFiltered(m.groupJid, m.messageId, "duplicate");
      return; // aynı mesaj ikinci kez işlenmez
    }
    this.diag.onGroupAccepted(m.groupJid, m.messageId);

    const subject = await this.groupSubject(sock, m.groupJid);
    const prev = this.groups.get(m.groupJid);
    this.groups.set(m.groupJid, {
      jid: m.groupJid,
      subject,
      lastAt: m.sentAt,
      count: (prev?.count ?? 0) + 1,
    });

    const isTestGroup = this.config.testGroupJid === m.groupJid;
    if (!isTestGroup) {
      // Test grubu dışındaki mesajın içeriği yazılmaz.
      this.note(
        "info",
        `Mesaj görüldü, test grubu değil (içerik yazılmadı): grup ${m.groupJid}${subject ? ` "${subject}"` : ""}.`,
      );
      return;
    }

    let senderNumber = m.senderNumber;
    if (!senderNumber && m.senderLid) {
      try {
        senderNumber = numberFromJid(
          await sock.signalRepository.lidMapping.getPNForLID(m.senderLid),
        );
      } catch {
        senderNumber = null;
      }
    }

    console.log(
      [
        "",
        "──── Test grubunda yeni mesaj ────",
        `Grup kimliği   : ${m.groupJid}${subject ? ` (${subject})` : ""}`,
        `Gönderen numara: ${senderNumber ? `+${senderNumber}` : "gizli (telefon paylaşılmadı)"}`,
        `Gönderen kimlik: ${m.senderJid}`,
        `Mesaj kimliği  : ${m.messageId}`,
        `Mesaj içeriği  : ${m.text}`,
        `Tarih ve saat  : ${istanbulTime(m.sentAt)} (Europe/Istanbul) · ${m.sentAt}`,
        "──────────────────────────────────",
      ].join("\n"),
    );
    this.note(
      "message",
      `Test grubu: ${maskNumber(senderNumber)} → "${m.text.slice(0, 80)}" (${m.messageId}).`,
    );

    await this.react(sock, msg, m.messageId);
  }

  /**
   * A1: grup metni → kayıt (veritabanı yalnız bağlı ve aktif grubun mesajını saklar). Bağlı olmayan
   * grubun metni hiçbir yere yazılmaz. Gruba yazılan kodlar artık İŞLENMEZ (kodsuz eşleştirme).
   */
  private async onA1Message(
    sock: WASocket,
    msg: WAMessage,
    m: InboundGroupMessage,
    backlog: boolean,
    key: string,
  ) {
    const senderPn = await this.resolveSender(sock, m);
    const out = await this.ingestDurable(key, {
      groupJid: m.groupJid,
      messageId: m.messageId,
      senderJid: m.senderJid,
      senderPn,
      senderLid: m.senderLid,
      body: m.text,
      sentAt: m.sentAt,
      kind: backlog ? "backlog" : "live",
    });
    this.diag.onOutcome(m.groupJid, m.messageId, out);
    if (out) this.stats[out] += 1;
    if (out === "stored") {
      const g = this.groups.get(m.groupJid);
      if (g) {
        g.count += 1;
        g.lastAt = m.sentAt;
      }
    }
  }

  /**
   * Veritabanına dayanıklı yazım: hata olursa kısa beklemelerle yeniden denenir; yine olmazsa
   * mesaj bellekteki kuyruğa alınır ve düzenli olarak (ve bağlantı açılınca) yeniden gönderilir.
   * Mesaj ASLA sessizce kaybolmaz: her hata sayılır ve günlüğe (içeriksiz) yazılır. Veritabanı
   * aynı mesajı tekil tuttuğu için yeniden gönderim çift kayıt üretmez.
   * Sınır: süreç çökerse bellekteki kuyruk kaybolur (diskte kuyruk Aşama 3).
   */
  private async ingestDurable(key: string, record: InboundRecord): Promise<IngestOutcome | null> {
    const store = this.store;
    if (!store) return null;
    const delays = [0, ...this.t.ingestRetryMs];
    let last: unknown = null;
    for (const [i, d] of delays.entries()) {
      if (d > 0) await sleep(d);
      try {
        const out = await store.ingest(record);
        this.seen.add(key);
        return out;
      } catch (e: unknown) {
        last = e;
        if (i === 0) this.stats.ingestRetried += 1;
      }
    }
    this.stats.errors += 1;
    this.enqueuePending(key, record);
    this.note(
      "error",
      `Mesaj veritabanına yazılamadı (${errName(last)}); bellekte bekletiliyor ve ${Math.round(this.t.pendingRetryMs / 1000)} sn'de bir yeniden denenecek (bekleyen ${this.pending.length}).`,
    );
    return null;
  }

  private enqueuePending(key: string, record: InboundRecord) {
    if (this.pending.some((p) => p.key === key)) return;
    this.pending.push({ key, record, firstAt: this.now() });
    while (this.pending.length > this.t.pendingMax) {
      const dropped = this.pending.shift();
      this.stats.ingestDropped += 1;
      this.note(
        "error",
        `Bekleyen mesaj kuyruğu dolu (${this.t.pendingMax}); en eski mesaj düşürüldü (${dropped?.record.messageId ?? "?"}).`,
      );
    }
  }

  /** Bekleyen mesajları sırayla yeniden yazar; ilk hatada durur (sonraki turda devam). */
  flushPending(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      const store = this.store;
      if (!store) return;
      let wrote = 0;
      while (this.pending.length > 0) {
        const p = this.pending[0]!;
        let out: IngestOutcome;
        try {
          out = await store.ingest(p.record);
        } catch {
          break;
        }
        this.pending.shift();
        this.seen.add(p.key);
        this.stats[out] += 1;
        this.diag.onOutcome(p.record.groupJid, p.record.messageId, out);
        wrote += 1;
      }
      if (wrote > 0) {
        this.note(
          "info",
          `Bekleyen ${wrote} mesaj veritabanına yazıldı (kalan ${this.pending.length}).`,
        );
      }
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /**
   * A1.1: asistana ÖZEL mesaj. Yalnız tam "kiraligim doğrula XXXX-XXXX" mesajı işlenir: gönderenin
   * numarası (WhatsApp'ın bildirdiği) kodu üreten kullanıcıya doğrulanmış numara olarak bağlanır;
   * başarıda o mesaja ✅. Başka özel mesajlar okunmaz, saklanmaz, günlüğe yazılmaz, yanıtlanmaz.
   */
  private async onDirectMessage(sock: WASocket, msg: WAMessage) {
    const explained = explainDirectMessage(msg);
    if (!explained.ok) {
      this.diag.onDirect("filtered", explained.reason);
      return;
    }
    const m = explained.message;
    const code = parseVerifyMessage(m.text);
    if (!code) {
      this.diag.onDirect("not_code");
      return;
    }
    this.diag.onDirect("code");
    if (!this.seen.add(`dm|${m.messageId}`)) return;
    const senderPn = await this.resolvePn(sock, { pn: m.senderPn, lid: m.senderLid });
    const out = await this.db("verify_phone", (s) => s.verifyPhone(code, senderPn));
    if (out === "verified") {
      this.stats.verified += 1;
      this.note("info", `Numara doğrulandı: ${maskNumber(senderPn)}.`);
      await this.sendReaction(sock, msg, VERIFY_REACTION, m.messageId);
    } else if (out) {
      this.stats.rejectedCodes += 1;
      this.note("info", `Doğrulama kodu kabul edilmedi (${out}).`);
    }
  }

  /**
   * A2f: işlem sonucu tepkileri. Worker mesajı işledikten sonra veritabanı kuyruğuna (outbox) yazar;
   * burada YALNIZ bağlantı açık, kopya kilidi bizde ve veritabanı varken bu bağlantının tepkileri
   * alınır ve mesajın üzerine reaction olarak gönderilir (gruba metin yazılmaz). Sonuç veritabanına
   * yazılır: hata → artan beklemeyle yeniden (en fazla 5), 24 saatten eskisi gönderilmez.
   * Bağlantı kesikken hiçbir şey alınmaz: kuyruk bekler; takvim ve mesaj kuyruğu etkilenmez.
   * Aynı tepkinin (ör. sonuç yazılamadıktan sonra) yeniden gönderilmesi WhatsApp'ta tekrar görünmez:
   * aynı mesaja aynı kişinin tepkisi yerine yazılır. Dakikadaki tepki sınırı (10) paylaşılır.
   */
  async flushReactions(): Promise<void> {
    if (this.reactionFlushing) return this.reactionFlushing;
    // Ön koşullar promise oluşturulmadan ÖNCE denetlenir. (Eski sürümde erken çıkış, "finally"
    // atamadan önce çalıştığı için tek uçuş kilidini bitmiş bir promise olarak bırakıyor ve
    // bağlantı bir kez koptuktan sonra kuyruk bir daha hiç okunmuyordu.)
    const store = this.store;
    const sock = this.sock;
    if (!store || !sock || this.status !== "open" || !this.lease.held) return;
    const budget = Math.min(5, this.reactions.remaining(this.now()));
    if (budget === 0) return;
    const run = (async () => {
      const claimed = await this.db("claim_reactions", (s) => s.claimReactions(budget));
      for (const r of claimed ?? []) {
        // Bağlantı bu arada kapandıysa gönderilmez; kilit dolunca yeniden alınır.
        if (this.sock !== sock || this.status !== "open") break;
        await this.sendQueuedReaction(sock, store, r);
      }
    })().catch((e: unknown) => {
      // Beklenmeyen hata süreci düşürmez; kuyruk bir sonraki yoklamada yeniden denenir.
      this.note("error", `Tepki kuyruğu hatası: ${errName(e)}`);
    });
    // Kilit, atamadan SONRA ve yalnız bu uçuş bitince bırakılır (.finally her zaman eşzamansızdır).
    const flight = run.finally(() => {
      if (this.reactionFlushing === flight) this.reactionFlushing = null;
    });
    this.reactionFlushing = flight;
    return flight;
  }

  private async sendQueuedReaction(sock: WASocket, store: WaStore, r: QueuedReaction) {
    let ok = false;
    let code: string | null = null;
    if (!this.reactions.tryTake(this.now())) {
      code = "rate_limited";
    } else {
      try {
        const sent = await withTimeout(
          sock.sendMessage(r.groupJid, {
            react: {
              text: r.emoji,
              key: {
                remoteJid: r.groupJid,
                id: r.waMessageId,
                participant: r.senderJid,
                fromMe: false,
              },
            },
          }),
          this.t.reactionSendTimeoutMs,
          "reaction_timeout",
        );
        ok = true;
        // Sunucu onayı/reddi "messages.update" ile loglanır (yalnız mesaj kimliği ve emoji).
        const id = sent?.key?.id ?? "";
        if (id) this.trackReaction(id, `${r.emoji} → ${r.waMessageId}`);
      } catch (e: unknown) {
        code = e instanceof Error && e.message === "reaction_timeout" ? "timeout" : "send_error";
      }
    }
    if (ok) {
      this.stats.reactionsSent += 1;
      this.note("reaction", `İşlem tepkisi gönderildi: ${r.emoji} → ${r.waMessageId}.`);
    } else {
      this.stats.reactionsFailed += 1;
      this.note("error", `İşlem tepkisi gönderilemedi (${code}): ${r.waMessageId}.`);
    }
    // Sonuç yazılamazsa kilit dolunca yeniden alınır (aynı emoji tekrar görünmez).
    await this.db("finish_reaction", () => store.finishReaction(r, ok, code));
  }

  /** Sunucu onayı beklenen tepki (sınırlı: onay hiç gelmezse en eskisi düşer). */
  private trackReaction(id: string, label: string) {
    this.pendingReactions.set(id, label);
    if (this.pendingReactions.size > 200) {
      const oldest = this.pendingReactions.keys().next().value;
      if (oldest !== undefined) this.pendingReactions.delete(oldest);
    }
  }

  /** Emoji tepkisi (dakikada en fazla 10). Metin mesajı gönderilmez. */
  private async sendReaction(sock: WASocket, msg: WAMessage, emoji: string, messageId: string) {
    const groupJid = msg.key.remoteJid;
    if (!groupJid || msg.key.fromMe) return;
    if (!this.reactions.tryTake()) {
      this.note("error", `Tepki atlandı: dakikada en fazla 10 tepki sınırı (${messageId}).`);
      return;
    }
    try {
      const sent = await sock.sendMessage(groupJid, { react: { text: emoji, key: msg.key } });
      const id = sent?.key?.id ?? "";
      if (id) this.trackReaction(id, `${emoji} → ${messageId}`);
      this.note("reaction", `Tepki gönderildi: ${emoji} → ${messageId}.`);
    } catch (e: unknown) {
      this.note(
        "error",
        `Tepki gönderilemedi (${messageId}): ${e instanceof Error ? e.name : "Error"}`,
      );
    }
  }

  /** Faz 1 test biçimi: test grubundaki gelen mesaja tepki. Metin mesajı gönderilmez. */
  private async react(sock: WASocket, msg: WAMessage, messageId: string) {
    const groupJid = msg.key.remoteJid;
    if (!groupJid || groupJid !== this.config.testGroupJid || msg.key.fromMe) return;
    if (!this.reactions.tryTake()) {
      this.note("error", `Tepki atlandı: dakikada en fazla 10 tepki sınırı (${messageId}).`);
      return;
    }
    try {
      const sent = await sock.sendMessage(groupJid, {
        react: { text: this.config.reaction, key: msg.key },
      });
      const id = sent?.key?.id ?? "";
      if (id) this.trackReaction(id, `${this.config.reaction} → ${messageId}`);
      this.note(
        "reaction",
        `Tepki gönderildi: ${this.config.reaction} → ${messageId}. Sunucu onayı bekleniyor.`,
      );
    } catch (e: unknown) {
      this.note(
        "error",
        `Tepki gönderilemedi (${messageId}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  /** Bağlantıyı kapatır; oturum korunur (sonraki başlatmada QR gerekmez). */
  async stop() {
    this.shuttingDown = true;
    this.clearTimer();
    this.stopTimers();
    this.generation += 1;
    // Sürmekte olan bağlantı kurulumu biter (yeni soket açılmaz: kuşak değişti).
    if (this.connecting) {
      await withTimeout(this.connecting, 5_000, "connect_timeout").catch(() => undefined);
    }
    // Bekleyen mesajlar kapanmadan önce (en fazla flushTimeoutMs) veritabanına yazılmaya çalışılır.
    if (this.store && this.pending.length > 0) {
      await withTimeout(this.flushPending(), this.t.flushTimeoutMs, "flush_timeout").catch(
        () => undefined,
      );
      if (this.pending.length > 0) {
        this.note(
          "error",
          `Kapanışta ${this.pending.length} mesaj veritabanına yazılamadı (bellekteydi).`,
        );
      }
    }
    this.teardownSocket();
    this.status = "stopped";
    if (this.store && this.lease.held) {
      await this.db("heartbeat", (s) =>
        s.heartbeat("closed", this.lastCode === "watchdog_exit" ? "watchdog_exit" : "stopped"),
      );
    }
    await this.lease.release().catch(() => undefined);
  }

  /**
   * Arayüzden ELLE tetiklenen sıfırlama: bu cihazın bağlantısını kaldırır, yerel anahtarları
   * siler ve yeni QR için yeniden başlar. Otomatik hiçbir yol bu fonksiyonu çağırmaz.
   */
  async reset() {
    this.halted = true;
    this.clearTimer();
    this.generation += 1;
    const sock = this.sock;
    if (sock) {
      try {
        await sock.logout();
      } catch {
        /* bağlantı zaten kapalı */
      }
    }
    this.teardownSocket();
    if (this.connecting) await this.connecting.catch(() => undefined);
    await this.removeAuth();
    this.account = null;
    this.connectedAt = null;
    this.qr = null;
    this.attempt = 0;
    this.badSessionStreak = 0;
    this.replacedAt.length = 0;
    this.lastCode = null;
    this.degraded = false;
    this.note("info", "Oturum elle sıfırlandı; yeni QR hazırlanıyor.");
    this.halted = false;
    this.setStatus("starting", null);
    await this.connect();
  }

  private async removeAuth() {
    const dir = this.config.authDir;
    // Güvenlik: yalnız ".wa-auth" adlı, sembolik bağlantı olmayan oturum klasörü silinir
    // (konum loadConfig'te servis klasörüyle sınırlandı; burada ikinci kez denetlenir).
    const problem = authDirProblem(dir, path.dirname(dir));
    if (problem) {
      this.note("error", `Oturum klasörü silinmedi: ${problem}`);
      return;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Günlük için kısa hata adı: kendi kodlarımız (ör. auth_timeout), SQLSTATE veya hata adı. */
function errName(e: unknown): string {
  if (e instanceof Error) {
    if (/^[a-z_]{1,40}$/.test(e.message)) return e.message;
    return (e as { code?: string }).code ?? e.name;
  }
  return "Error";
}
