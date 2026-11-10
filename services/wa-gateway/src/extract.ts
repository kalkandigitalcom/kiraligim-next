/**
 * Gelen WhatsApp mesajından test için gereken alanları çıkarır (saf fonksiyonlar, ağ yok).
 * Gruplarda gönderen bazen telefonla (…@s.whatsapp.net), bazen gizli kimlikle (…@lid) gelir;
 * Baileys v7 diğerini `participantAlt` alanında verir. Telefon bulunamazsa null döner, LID
 * ayrıca saklanır (yetkilendirme ileride telefona değil doğrulanmış kimliğe dayanacak).
 */
import {
  isJidGroup,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  type WAMessage,
} from "baileys";

export type InboundGroupMessage = {
  groupJid: string;
  messageId: string;
  /** Gönderenin kimliği (telefon veya LID). */
  senderJid: string;
  /** Telefon (yalnız rakam) biliniyorsa. */
  senderNumber: string | null;
  senderLid: string | null;
  text: string;
  /** ISO 8601 (UTC). */
  sentAt: string;
};

/** "905321112233@s.whatsapp.net" / "905321112233:12@s.whatsapp.net" → "905321112233". */
export function numberFromJid(jid: string | null | undefined): string | null {
  if (!jid || !isPnUser(jid)) return null;
  const user = jidNormalizedUser(jid).split("@")[0] ?? "";
  return /^[0-9]{6,20}$/.test(user) ? user : null;
}

/** Metin içerik: düz mesaj, uzun metin ya da görsel/video açıklaması. Diğer türler null. */
export function messageText(msg: WAMessage): string | null {
  const content = normalizeMessageContent(msg.message);
  if (!content) return null;
  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    null;
  return typeof text === "string" && text.trim() ? text : null;
}

function toIso(ts: WAMessage["messageTimestamp"]): string {
  const seconds =
    typeof ts === "number" ? ts : ts && typeof ts === "object" ? Number(ts.toString()) : NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : new Date().toISOString();
}

/**
 * Bir mesajın neden işlenmediği (teşhis; içerik ve numara içermez).
 *  - no_key: anahtar veya mesaj kimliği yok;  from_me: asistanın kendi mesajı;
 *  - not_group / not_direct: beklenen sohbet türü değil;
 *  - ciphertext: çözülemeyen mesaj yer tutucusu (Baileys yeniden deneme ister);
 *  - stub: içeriksiz sistem kaydı (grup bildirimi vb.);  no_content: içerik yok;
 *  - reaction / protocol: tepki, düzenleme/silme/ayar gibi protokol mesajı;
 *  - non_text: metin veya açıklama içermeyen tür (çıkartma, ses, anket…);
 *  - no_sender: gönderen kimliği yok.
 */
export type FilterReason =
  | "no_key"
  | "from_me"
  | "not_group"
  | "not_direct"
  | "ciphertext"
  | "stub"
  | "no_content"
  | "reaction"
  | "protocol"
  | "non_text"
  | "no_sender";

export type Explained<T> =
  { ok: true; message: T } | { ok: false; reason: FilterReason; contentType?: string };

/** İçeriğin ilk alan adı (ör. "stickerMessage"); teşhis için, içerik değil. */
function contentTypeOf(content: object): string | undefined {
  const k = Object.keys(content).find((x) => /^[a-zA-Z]{1,40}$/.test(x));
  return k;
}

function contentReason(
  msg: WAMessage,
): { ok: false; reason: FilterReason; contentType?: string } | { ok: true; text: string } {
  const content = normalizeMessageContent(msg.message);
  if (!content) {
    if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
      return { ok: false, reason: "ciphertext" };
    }
    return { ok: false, reason: msg.messageStubType ? "stub" : "no_content" };
  }
  if (content.reactionMessage) return { ok: false, reason: "reaction" };
  if (content.protocolMessage) return { ok: false, reason: "protocol" };
  const text = messageText(msg);
  if (text === null) {
    const contentType = contentTypeOf(content);
    return { ok: false, reason: "non_text", ...(contentType ? { contentType } : {}) };
  }
  return { ok: true, text };
}

/**
 * Yalnız başkasının gruba yazdığı metin mesajı; değilse NEDENİ. Kendi mesajları, tepkiler,
 * sistem/protokol mesajları, durum ve kanal yayınları elenir.
 */
export function explainGroupMessage(msg: WAMessage): Explained<InboundGroupMessage> {
  const key = msg.key;
  const groupJid = key?.remoteJid ?? "";
  if (!key || !key.id) return { ok: false, reason: "no_key" };
  if (key.fromMe) return { ok: false, reason: "from_me" };
  if (!isJidGroup(groupJid)) return { ok: false, reason: "not_group" };
  const c = contentReason(msg);
  if (!c.ok) return c;

  const participant = key.participant ?? "";
  const alt = key.participantAlt ?? "";
  const pn = isPnUser(participant) ? participant : isPnUser(alt) ? alt : null;
  const lid = isLidUser(participant) ? participant : isLidUser(alt) ? alt : null;
  const senderJid = participant || alt;
  if (!senderJid) return { ok: false, reason: "no_sender" };

  return {
    ok: true,
    message: {
      groupJid,
      messageId: key.id,
      senderJid,
      senderNumber: numberFromJid(pn),
      senderLid: lid,
      text: c.text,
      sentAt: toIso(msg.messageTimestamp),
    },
  };
}

/** explainGroupMessage'ın kısa biçimi: işlenecek mesaj ya da null. */
export function extractGroupMessage(msg: WAMessage): InboundGroupMessage | null {
  const r = explainGroupMessage(msg);
  return r.ok ? r.message : null;
}

export type InboundDirectMessage = {
  messageId: string;
  /** Gönderenin telefonu (yalnız rakam) biliniyorsa. */
  senderPn: string | null;
  senderLid: string | null;
  text: string;
};

/**
 * Asistana gelen ÖZEL (bire bir) metin mesajı; değilse NEDENİ. Grup, durum, kanal ve yayın
 * mesajları ile kendi mesajları elenir. İçerik yalnız numara doğrulama kodu için okunur;
 * saklanmaz ve yazılmaz.
 */
export function explainDirectMessage(msg: WAMessage): Explained<InboundDirectMessage> {
  const key = msg.key;
  const remote = key?.remoteJid ?? "";
  if (!key || !key.id || !remote) return { ok: false, reason: "no_key" };
  if (key.fromMe) return { ok: false, reason: "from_me" };
  if (isJidGroup(remote) || !(isPnUser(remote) || isLidUser(remote))) {
    return { ok: false, reason: "not_direct" };
  }
  const c = contentReason(msg);
  if (!c.ok) return c;
  const alt = key.remoteJidAlt ?? "";
  const pnJid = isPnUser(remote) ? remote : isPnUser(alt) ? alt : null;
  const lid = isLidUser(remote) ? remote : isLidUser(alt) ? alt : null;
  return {
    ok: true,
    message: {
      messageId: key.id,
      senderPn: numberFromJid(pnJid),
      senderLid: lid ? jidNormalizedUser(lid) : null,
      text: c.text,
    },
  };
}

/** explainDirectMessage'ın kısa biçimi. */
export function extractDirectMessage(msg: WAMessage): InboundDirectMessage | null {
  const r = explainDirectMessage(msg);
  return r.ok ? r.message : null;
}

/** "905321112233" → "+90 532 *** ** 33" (arayüzde ve konsolda numara gizlenir). */
export function maskNumber(num: string | null): string {
  if (!num) return "bilinmiyor";
  if (num.length < 8) return "***";
  return `+${num.slice(0, 2)} ${num.slice(2, 5)} *** ** ${num.slice(-2)}`;
}

/** Europe/Istanbul yerel saati: "09.11.2026 14:32:05". */
export function istanbulTime(iso: string): string {
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(iso));
}
