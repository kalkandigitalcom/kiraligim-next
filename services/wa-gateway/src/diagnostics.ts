/**
 * Aşama 1.1 — mesaj alımı teşhisi (yalnız gözlem; davranış değiştirmez).
 *
 * Amaç: bir mesajın nerede kaybolduğunu kesin ayırt etmek:
 *   1. ham paket: WhatsApp WebSocket'inden "message" paketi geldi mi? (Baileys'ten ÖNCE)
 *   2. upsert:    Baileys paketi çözüp messages.upsert olayına dönüştürdü mü?
 *   3. filtre:    bizim ayıklama katmanımız neden eledi?
 *   4. kayıt:     veritabanı sonucu (stored / duplicate / ignored / hata).
 *
 * Mesaj METNİ, telefon numarası, gönderen kimliği, auth veya anahtar bilgisi TUTULMAZ ve
 * YAZILMAZ. Yalnız sayaçlar, zamanlar, grup kimliği (yerel arayüzde zaten görünen) ve mesaj
 * kimliği (rastgele). WA_TRACE=1 iken her adım için tek satırlık metadata günlüğü yazılır;
 * günlükte grup kimliği yalnız son 6 hanesiyle, özel sohbetler yalnız "özel" olarak görünür.
 */
import type { FilterReason } from "./extract.ts";

export type RawNode = { attrs?: Record<string, string | undefined> };

type GroupDiag = {
  raw: number;
  upsert: number;
  accepted: number;
  stored: number;
  duplicate: number;
  ignored: number;
  failed: number;
  lastRawAt: number | null;
  lastUpsertAt: number | null;
  lastDecision: string | null;
};

export type UndecryptableKind =
  "no_session" | "missing_keys" | "no_message" | "bad_mac" | "no_sender_key" | "other";

/** Baileys'in CIPHERTEXT yer tutucusundaki hata metnini kısa bir türe çevirir (metin saklanmaz). */
export function undecryptableKind(param: unknown): UndecryptableKind {
  const t = typeof param === "string" ? param : "";
  if (/no session/i.test(t)) return "no_session";
  if (/key used already|never filled/i.test(t)) return "missing_keys";
  if (/absent from node/i.test(t)) return "no_message";
  if (/bad mac/i.test(t)) return "bad_mac";
  if (/senderkey|sender key/i.test(t)) return "no_sender_key";
  return "other";
}

/** "120363411788827787@g.us" → "…827787" (günlük için). */
export function shortJid(jid: string | null | undefined): string {
  const user = (jid ?? "").split("@")[0] ?? "";
  return user ? `…${user.slice(-6)}` : "?";
}

/** Paketin kaynağı: grup / özel / diğer (durum, kanal, yayın). Kimlik saklanmaz. */
export function rawKind(from: string | undefined): "group" | "direct" | "other" {
  if (!from) return "other";
  if (from.endsWith("@g.us")) return "group";
  if (from.endsWith("@s.whatsapp.net") || from.endsWith("@lid")) return "direct";
  return "other";
}

const MAX_GROUPS = 100;
const MAX_TYPES = 30;
/** Ham paket geldikten bu kadar sonra hâlâ upsert yoksa "işleme takıldı" şüphesi. */
export const STALL_AFTER_MS = 120_000;

const safeId = (id: string | undefined) => (id && /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : "?");

export class MessageDiagnostics {
  readonly raw = {
    message: 0,
    group: 0,
    direct: 0,
    other: 0,
    offline: 0,
    notification: 0,
    /** Bu soket kuşağı dışından (eski soket) gelen ham paket. */
    stale: 0,
    lastMessageAt: null as number | null,
    lastGroupAt: null as number | null,
    lastDirectAt: null as number | null,
    lastFrameAt: null as number | null,
  };
  readonly upsert = {
    events: 0,
    messages: 0,
    notify: 0,
    append: 0,
    other: 0,
    /** A1'de işlenmeyen tür (notify/append dışı) yüzünden atlanan mesaj. */
    skippedType: 0,
    /** Eski soketten gelen ve yok sayılan olay. */
    stale: 0,
    lastAt: null as number | null,
  };
  readonly filtered: Record<FilterReason | "duplicate", number> = {
    no_key: 0,
    from_me: 0,
    not_group: 0,
    not_direct: 0,
    ciphertext: 0,
    stub: 0,
    no_content: 0,
    reaction: 0,
    protocol: 0,
    non_text: 0,
    no_sender: 0,
    duplicate: 0,
  };
  readonly nonTextTypes: Record<string, number> = {};
  readonly undecryptable: Record<UndecryptableKind, number> = {
    no_session: 0,
    missing_keys: 0,
    no_message: 0,
    bad_mac: 0,
    no_sender_key: 0,
    other: 0,
  };
  readonly processing = {
    accepted: 0,
    stored: 0,
    duplicate: 0,
    ignored: 0,
    /** Yeniden denemelerden sonra yazılamayıp kuyruğa alınan. */
    failed: 0,
    lastAcceptedAt: null as number | null,
    lastStoredAt: null as number | null,
  };
  readonly direct = { received: 0, filtered: 0, notCode: 0, verifyCodes: 0 };
  readonly socket = {
    generation: 0,
    createdAt: null as number | null,
    openAt: null as number | null,
    offlineSyncedAt: null as number | null,
  };
  private readonly groups = new Map<string, GroupDiag>();
  private stallLogged = false;

  constructor(
    private readonly now: () => number,
    private readonly trace: boolean,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {}

  private t(line: string) {
    if (this.trace) this.log(`[wa-trace] ${line}`);
  }

  private group(jid: string): GroupDiag {
    let g = this.groups.get(jid);
    if (!g) {
      if (this.groups.size >= MAX_GROUPS) {
        const first = this.groups.keys().next().value;
        if (first !== undefined) this.groups.delete(first);
      }
      g = {
        raw: 0,
        upsert: 0,
        accepted: 0,
        stored: 0,
        duplicate: 0,
        ignored: 0,
        failed: 0,
        lastRawAt: null,
        lastUpsertAt: null,
        lastDecision: null,
      };
      this.groups.set(jid, g);
    }
    return g;
  }

  onSocket(generation: number) {
    this.socket.generation = generation;
    this.socket.createdAt = this.now();
    this.socket.openAt = null;
    this.socket.offlineSyncedAt = null;
    this.t(`soket oluşturuldu kuşak=${generation}`);
  }

  onOpen() {
    this.socket.openAt = this.now();
    this.t(`soket açık kuşak=${this.socket.generation}`);
  }

  onOfflineSynced() {
    this.socket.offlineSyncedAt = this.now();
    this.t("bekleyen çevrimdışı bildirimler işlendi");
  }

  onFrame() {
    this.raw.lastFrameAt = this.now();
  }

  onRawNotification() {
    this.raw.notification += 1;
  }

  /** 1. katman: WebSocket'ten gelen ham "message" paketi (Baileys işlemeden önce). */
  onRawMessage(node: RawNode, live: boolean) {
    const now = this.now();
    const attrs = node.attrs ?? {};
    if (!live) {
      this.raw.stale += 1;
      return;
    }
    const kind = rawKind(attrs.from);
    this.raw.message += 1;
    this.raw[kind] += 1;
    this.raw.lastMessageAt = now;
    if (attrs.offline) this.raw.offline += 1;
    if (kind === "group" && attrs.from) {
      const g = this.group(attrs.from);
      g.raw += 1;
      g.lastRawAt = now;
      this.raw.lastGroupAt = now;
      this.stallLogged = false;
    } else if (kind === "direct") {
      this.raw.lastDirectAt = now;
      this.stallLogged = false;
    }
    this.t(
      `ham paket tür=${kind === "group" ? `grup grp=${shortJid(attrs.from)}` : kind === "direct" ? "özel" : "diğer"} id=${safeId(attrs.id)} çevrimdışı=${attrs.offline ? "evet" : "hayır"}`,
    );
  }

  /** 2. katman: Baileys messages.upsert olayı. */
  onUpsert(
    type: string,
    messages: readonly {
      key?: { remoteJid?: string | null; id?: string | null } | null;
      messageStubType?: number | null;
      messageStubParameters?: readonly unknown[] | null;
    }[],
    live: boolean,
    ciphertextStub: number,
  ) {
    if (!live) {
      this.upsert.stale += messages.length;
      this.t(`upsert eski soketten yok sayıldı tür=${type} adet=${messages.length}`);
      return;
    }
    const now = this.now();
    this.upsert.events += 1;
    this.upsert.messages += messages.length;
    if (type === "notify") this.upsert.notify += messages.length;
    else if (type === "append") this.upsert.append += messages.length;
    else this.upsert.other += messages.length;
    this.upsert.lastAt = now;
    this.t(`upsert tür=${type} adet=${messages.length}`);
    for (const m of messages) {
      const jid = m.key?.remoteJid ?? "";
      if (jid.endsWith("@g.us")) {
        const g = this.group(jid);
        g.upsert += 1;
        g.lastUpsertAt = now;
      }
      if (m.messageStubType === ciphertextStub) {
        const kind = undecryptableKind(m.messageStubParameters?.[0]);
        this.undecryptable[kind] += 1;
        this.t(
          `çözülemeyen mesaj grp=${jid.endsWith("@g.us") ? shortJid(jid) : "özel"} id=${safeId(m.key?.id ?? undefined)} neden=${kind}`,
        );
      }
    }
  }

  onSkippedType(type: string, count: number) {
    this.upsert.skippedType += count;
    this.t(`upsert türü işlenmiyor tür=${type} adet=${count}`);
  }

  /** 3. katman: grup mesajı ayıklandı (neden) ya da kabul edildi. */
  onGroupFiltered(
    jid: string | null | undefined,
    id: string | null | undefined,
    reason: FilterReason | "duplicate",
    contentType?: string,
  ) {
    this.filtered[reason] += 1;
    if (reason === "non_text" && contentType) {
      if (contentType in this.nonTextTypes || Object.keys(this.nonTextTypes).length < MAX_TYPES) {
        this.nonTextTypes[contentType] = (this.nonTextTypes[contentType] ?? 0) + 1;
      }
    }
    if (jid?.endsWith("@g.us")) {
      this.group(jid).lastDecision = `filtered:${reason}`;
    }
    this.t(
      `grup mesajı elendi grp=${jid?.endsWith("@g.us") ? shortJid(jid) : "?"} id=${safeId(id ?? undefined)} neden=${reason}${contentType ? ` içerik=${contentType}` : ""}`,
    );
  }

  onGroupAccepted(jid: string, id: string) {
    const now = this.now();
    this.processing.accepted += 1;
    this.processing.lastAcceptedAt = now;
    const g = this.group(jid);
    g.accepted += 1;
    g.lastDecision = "accepted";
    this.t(`grup mesajı kabul edildi grp=${shortJid(jid)} id=${safeId(id)}`);
  }

  /** 4. katman: veritabanı sonucu. null = yeniden denemelerden sonra yazılamadı (kuyrukta). */
  onOutcome(jid: string, id: string, out: "stored" | "duplicate" | "ignored" | null) {
    const g = this.group(jid);
    if (out === null) {
      this.processing.failed += 1;
      g.failed += 1;
      g.lastDecision = "failed";
    } else {
      this.processing[out] += 1;
      g[out] += 1;
      g.lastDecision = out;
      if (out === "stored") this.processing.lastStoredAt = this.now();
    }
    this.t(`kayıt sonucu grp=${shortJid(jid)} id=${safeId(id)} sonuç=${out ?? "hata_kuyrukta"}`);
  }

  onDirect(decision: "filtered" | "not_code" | "code", reason?: FilterReason) {
    this.direct.received += 1;
    if (decision === "filtered") this.direct.filtered += 1;
    else if (decision === "not_code") this.direct.notCode += 1;
    else this.direct.verifyCodes += 1;
    this.t(
      `özel mesaj karar=${decision === "filtered" ? `elendi:${reason ?? "?"}` : decision === "not_code" ? "doğrulama_kodu_değil" : "doğrulama_kodu"}`,
    );
  }

  /**
   * Ham paket geldi ama STALL_AFTER_MS boyunca hiç upsert olmadıysa: Baileys işleme hattında
   * takılma şüphesi. Yalnız uyarı (yeniden başlatma YOK); bölüm başına bir kez günlüğe yazılır.
   */
  stallSuspected(now = this.now()): boolean {
    const lastRaw = Math.max(this.raw.lastGroupAt ?? 0, this.raw.lastDirectAt ?? 0);
    if (!lastRaw) return false;
    if (this.upsert.lastAt !== null && this.upsert.lastAt >= lastRaw) return false;
    return now - lastRaw >= STALL_AFTER_MS;
  }

  checkStall(warn: (msg: string) => void) {
    if (this.stallLogged || !this.stallSuspected()) return;
    this.stallLogged = true;
    warn(
      "Teşhis: WhatsApp'tan ham mesaj paketi geldi ama 2 dakikadır hiçbir messages.upsert olayı oluşmadı (Baileys işleme hattı takılmış olabilir). Otomatik işlem yapılmadı.",
    );
  }

  snapshot() {
    const now = this.now();
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    const ago = (t: number | null) =>
      t === null ? null : Math.max(0, Math.round((now - t) / 1000));
    return {
      trace: this.trace,
      socket: {
        generation: this.socket.generation,
        createdAt: iso(this.socket.createdAt),
        openAt: iso(this.socket.openAt),
        offlineSyncedAt: iso(this.socket.offlineSyncedAt),
      },
      raw: {
        ...this.raw,
        lastMessageAt: iso(this.raw.lastMessageAt),
        lastGroupAt: iso(this.raw.lastGroupAt),
        lastDirectAt: iso(this.raw.lastDirectAt),
        lastFrameAt: iso(this.raw.lastFrameAt),
        lastMessageAgoSec: ago(this.raw.lastMessageAt),
        lastFrameAgoSec: ago(this.raw.lastFrameAt),
      },
      upsert: {
        ...this.upsert,
        lastAt: iso(this.upsert.lastAt),
        lastAgoSec: ago(this.upsert.lastAt),
      },
      filtered: { ...this.filtered },
      nonTextTypes: { ...this.nonTextTypes },
      undecryptable: { ...this.undecryptable },
      processing: {
        ...this.processing,
        lastAcceptedAt: iso(this.processing.lastAcceptedAt),
        lastStoredAt: iso(this.processing.lastStoredAt),
      },
      direct: { ...this.direct },
      stallSuspected: this.stallSuspected(now),
      groups: [...this.groups.entries()].map(([jid, g]) => ({
        jid,
        ...g,
        lastRawAt: iso(g.lastRawAt),
        lastUpsertAt: iso(g.lastUpsertAt),
      })),
    };
  }
}
