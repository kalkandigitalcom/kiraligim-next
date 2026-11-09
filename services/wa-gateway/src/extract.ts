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
 * Yalnız başkasının gruba yazdığı metin mesajı. Kendi mesajları, tepkiler, sistem/protokol
 * mesajları, durum ve kanal yayınları null döner.
 */
export function extractGroupMessage(msg: WAMessage): InboundGroupMessage | null {
  const key = msg.key;
  const groupJid = key?.remoteJid ?? "";
  if (!key || key.fromMe || !isJidGroup(groupJid) || !key.id) return null;
  const content = normalizeMessageContent(msg.message);
  if (!content || content.reactionMessage || content.protocolMessage) return null;
  const text = messageText(msg);
  if (text === null) return null;

  const participant = key.participant ?? "";
  const alt = key.participantAlt ?? "";
  const pn = isPnUser(participant) ? participant : isPnUser(alt) ? alt : null;
  const lid = isLidUser(participant) ? participant : isLidUser(alt) ? alt : null;
  const senderJid = participant || alt;
  if (!senderJid) return null;

  return {
    groupJid,
    messageId: key.id,
    senderJid,
    senderNumber: numberFromJid(pn),
    senderLid: lid,
    text,
    sentAt: toIso(msg.messageTimestamp),
  };
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
