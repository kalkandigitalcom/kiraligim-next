/**
 * WhatsApp bağlı cihaz oturumu (Baileys).
 *  - Yalnız WA_ALLOWED_NUMBER hesabı: başka hesap bağlanırsa oturum hemen kapatılır, anahtarlar
 *    silinir.
 *  - Bu modülde metin mesajı gönderen kod YOKTUR; tek dışa yazım emoji tepkisidir.
 *  - QR ve oturum anahtarları günlüğe yazılmaz; QR yalnız bellekte tutulur, yerel arayüzde gösterilir.
 *
 * A1 biçimi (veritabanı tanımlı): grupları keşfedip kaydeder (asistanı ekleyen kişi ve grup kurucusu
 * numaralarıyla; veritabanı yalnız özetini saklar), yalnız bağlı grupların metin mesajlarını kaydeder
 * (tekil), saatte bir saklama süresini uygular. Gruplara kod YAZILMAZ: kullanıcı numarasını bir kez
 * asistana ÖZEL mesajla doğrular (başarıda o mesaja ✅); grup eşleştirmesi panelden yapılır.
 * Mesaj içeriği ve numara günlüğe yazılmaz. Takvim, fiyat veya rezervasyon işlemi YOKTUR.
 *
 * Faz 1 test biçimi (veritabanı yok): test grubunun mesajını konsola yazar, tepki bırakır.
 */
import fs from "node:fs/promises";
import path from "node:path";

import makeWASocket, {
  Browsers,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "baileys";

import { authDirProblem, type Config } from "./config.ts";
import {
  extractDirectMessage,
  extractGroupMessage,
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
import { createSafeLogger } from "./logger.ts";
import { decideReconnect, isAllowedAccount, RateLimiter, SeenSet } from "./policy.ts";
import type { ConnectionStatus, WaStore } from "./store.ts";

/** Saklama süresi (gün); src/lib/whatsapp-meta.ts WA_RETENTION_DAYS ile aynı. */
export const RETENTION_DAYS = 90;
/** Tek dışa yazım: başarılı numara doğrulama mesajına tepki. */
const VERIFY_REACTION = "✅";

export type GatewayStatus = "starting" | "qr" | "connecting" | "open" | "reconnecting" | "stopped";

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
};

const MAX_EVENTS = 50;

export class WaGateway {
  status: GatewayStatus = "starting";
  reason: string | null = null;
  /** Ham QR yalnız bellekte; günlüğe yazılmaz. */
  qr: string | null = null;
  account: string | null = null;
  connectedAt: string | null = null;
  readonly events: GatewayEvent[] = [];
  readonly groups = new Map<string, SeenGroup>();

  private sock: WASocket | null = null;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private readonly seen = new SeenSet();
  private readonly reactions = new RateLimiter(10, 60_000);
  private readonly pendingReactions = new Map<string, string>();
  private readonly logger = createSafeLogger();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;
  readonly stats: GatewayStats = {
    stored: 0,
    duplicate: 0,
    ignored: 0,
    verified: 0,
    rejectedCodes: 0,
    errors: 0,
  };

  constructor(
    private readonly config: Config,
    private readonly store: WaStore | null = null,
  ) {}

  get mode(): "a1" | "test" {
    return this.store ? "a1" : "test";
  }

  /** Veritabanı çağrısı; hata bağlantıyı düşürmez, yalnız sayılır ve kısa günlüğe yazılır. */
  private async db<T>(label: string, fn: (store: WaStore) => Promise<T>): Promise<T | null> {
    if (!this.store) return null;
    try {
      return await fn(this.store);
    } catch (e: unknown) {
      this.stats.errors += 1;
      const name = e instanceof Error ? ((e as { code?: string }).code ?? e.name) : "Error";
      this.note("error", `Veritabanı hatası (${label}): ${name}`);
      return null;
    }
  }

  private heartbeat(status: ConnectionStatus, errorCode: string | null = null) {
    const accountPn = this.account;
    void this.db("heartbeat", (s) => s.heartbeat(status, errorCode, accountPn));
  }

  private note(kind: GatewayEvent["kind"], text: string) {
    this.events.unshift({ at: new Date().toISOString(), kind, text });
    this.events.length = Math.min(this.events.length, MAX_EVENTS);
    const line = `[wa] ${text}`;
    if (kind === "error") console.error(line);
    else console.log(line);
  }

  /** Oturum klasörü yalnız sahibine açık (0700); dosyalar Baileys tarafından yazılır. */
  private async ensureAuthDir() {
    await fs.mkdir(this.config.authDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.config.authDir, 0o700);
  }

  async start(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopping = false;
    this.status = this.attempt === 0 ? "starting" : "reconnecting";
    await this.ensureAuthDir();

    const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir);
    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      version = undefined; // kütüphanenin varsayılanı kullanılır
    }

    const sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.logger) },
      ...(version ? { version } : {}),
      logger: this.logger,
      browser: Browsers.macOS("Kiraligim Test"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldIgnoreJid: (jid) =>
        Boolean(isJidBroadcast(jid) || isJidNewsletter(jid) || isJidStatusBroadcast(jid)),
      getMessage: async () => undefined,
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (u) => {
      if (u.qr) {
        this.qr = u.qr;
        this.status = "qr";
        this.reason = null;
        this.note("info", "QR hazır: test arayüzünden okutun (QR günlüğe yazılmaz).");
      }
      if (u.connection === "connecting" && this.status !== "qr") {
        this.status = "connecting";
        this.heartbeat("connecting");
      }
      if (u.connection === "open") void this.onOpen(sock);
      if (u.connection === "close") {
        const err = u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
        void this.onClose(sock, err?.output?.statusCode);
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      // A1: kesinti sonrası birikim ("append") de kaydedilir ama "backlog" olarak işaretlenir.
      if (type !== "notify" && !(this.store && type === "append")) return;
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
        for (const meta of metas) void this.syncGroup(sock, meta);
      });
      sock.ev.on("groups.update", (updates) => {
        for (const u of updates) if (u.id) void this.refreshGroup(sock, u.id);
      });
      sock.ev.on("group-participants.update", (ev) => {
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

  private async onOpen(sock: WASocket) {
    if (sock !== this.sock) return;
    if (!isAllowedAccount(sock.user?.id, this.config.allowedNumber)) {
      this.note(
        "error",
        "İzin verilmeyen bir hesap bağlandı; oturum kapatılıyor ve anahtarlar siliniyor. Yalnız WA_ALLOWED_NUMBER kullanılabilir.",
      );
      this.stopping = true;
      try {
        await sock.logout();
      } catch {
        /* bağlantı zaten kapanmış olabilir */
      }
      await this.removeAuth();
      this.status = "stopped";
      this.reason = "İzin verilmeyen hesap reddedildi.";
      this.account = null;
      return;
    }
    this.attempt = 0;
    this.qr = null;
    this.status = "open";
    this.reason = null;
    this.account = numberFromJid(sock.user?.id ?? null);
    this.connectedAt = new Date().toISOString();
    this.note("info", `Bağlandı: ${maskNumber(this.account)}.`);
    if (this.store) {
      this.heartbeat("open");
      this.startTimers();
      await this.syncAllGroups(sock);
      return;
    }
    if (!this.config.testGroupJid) {
      this.note(
        "info",
        "WA_TEST_GROUP_JID tanımlı değil: tepki bırakılmayacak. Test grubuna bir mesaj yazın; grup kimliği arayüzde görünür.",
      );
    }
  }

  private async onClose(sock: WASocket, statusCode: number | undefined) {
    if (sock !== this.sock) return;
    this.sock = null;
    if (this.stopping) return;
    const decision = decideReconnect(statusCode, this.attempt);
    this.heartbeat(decision.action === "stop" && decision.resetAuth ? "logged_out" : "closed");
    if (decision.action === "stop") {
      this.status = "stopped";
      this.reason = decision.reason;
      this.qr = null;
      this.note("error", `Bağlantı durdu: ${decision.reason}`);
      if (decision.resetAuth) await this.removeAuth();
      return;
    }
    this.attempt += 1;
    this.status = "reconnecting";
    this.reason = decision.reason;
    this.note(
      "info",
      `${decision.reason} ${Math.round(decision.delayMs / 1000)} sn sonra yeniden bağlanılacak (deneme ${this.attempt}).`,
    );
    this.timer = setTimeout(() => {
      this.start().catch((e: unknown) =>
        this.note("error", `Yeniden bağlanma hatası: ${String(e)}`),
      );
    }, decision.delayMs);
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

  private startTimers() {
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        if (this.status === "open") this.heartbeat("open");
      }, 60_000);
      this.heartbeatTimer.unref();
    }
    if (!this.purgeTimer) {
      const purge = () =>
        void this.db("purge", async (s) => {
          const n = await s.purge(RETENTION_DAYS);
          if (n > 0) this.note("info", `Saklama: ${n} eski mesaj silindi.`);
        });
      purge();
      this.purgeTimer = setInterval(purge, 60 * 60_000);
      this.purgeTimer.unref();
    }
  }

  private stopTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.heartbeatTimer = null;
    this.purgeTimer = null;
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
    const m = extractGroupMessage(msg);
    if (!m) return;
    if (!this.seen.add(`${m.groupJid}|${m.messageId}`)) return; // aynı mesaj ikinci kez işlenmez

    if (this.store) {
      await this.onA1Message(sock, msg, m, backlog);
      return;
    }

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
  ) {
    const senderPn = await this.resolveSender(sock, m);
    const out = await this.db("ingest", (s) =>
      s.ingest({
        groupJid: m.groupJid,
        messageId: m.messageId,
        senderJid: m.senderJid,
        senderPn,
        senderLid: m.senderLid,
        body: m.text,
        sentAt: m.sentAt,
        kind: backlog ? "backlog" : "live",
      }),
    );
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
   * A1.1: asistana ÖZEL mesaj. Yalnız tam "kiraligim doğrula XXXX-XXXX" mesajı işlenir: gönderenin
   * numarası (WhatsApp'ın bildirdiği) kodu üreten kullanıcıya doğrulanmış numara olarak bağlanır;
   * başarıda o mesaja ✅. Başka özel mesajlar okunmaz, saklanmaz, günlüğe yazılmaz, yanıtlanmaz.
   */
  private async onDirectMessage(sock: WASocket, msg: WAMessage) {
    const m = extractDirectMessage(msg);
    if (!m) return;
    const code = parseVerifyMessage(m.text);
    if (!code) return;
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
      if (id) this.pendingReactions.set(id, `${emoji} → ${messageId}`);
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
      if (id) this.pendingReactions.set(id, `${this.config.reaction} → ${messageId}`);
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
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopTimers();
    if (this.store) await this.db("heartbeat", (s) => s.heartbeat("closed"));
    this.sock?.end(undefined);
    this.sock = null;
    this.status = "stopped";
  }

  /** Bu cihazın bağlantısını kaldırır, yerel anahtarları siler ve yeni QR için yeniden başlar. */
  async reset() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      try {
        await sock.logout();
      } catch {
        sock.end(undefined);
      }
    }
    await this.removeAuth();
    this.stopTimers();
    if (this.store) await this.db("heartbeat", (s) => s.heartbeat("logged_out"));
    this.account = null;
    this.connectedAt = null;
    this.qr = null;
    this.attempt = 0;
    this.note("info", "Oturum sıfırlandı; yeni QR hazırlanıyor.");
    await this.start();
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
