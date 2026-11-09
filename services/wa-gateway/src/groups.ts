/**
 * A1: grup meta verisinin veritabanı kaydına çevrilmesi ve numara doğrulama mesajının tanınması
 * (saf fonksiyonlar). Kod biçimi src/lib/whatsapp-meta.ts ile AYNIDIR; iki taraf aynı test
 * vektörleriyle denetlenir.
 *
 * A1.1 (kodsuz eşleştirme): gruplara kod YAZILMAZ. Doğrulama kodu yalnız asistana ÖZEL mesajla
 * gelir (bkz. session.ts onDirectMessage). Grup kaydında asistanı ekleyen kişinin (author) ve grup
 * kurucusunun (owner) numarası veritabanına iletilir; veritabanı yalnız özetini saklar.
 */
import { isLidUser, isPnUser, jidNormalizedUser } from "baileys";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const VERIFY_MESSAGE_RE =
  /^\s*k[ıiİI]ral[ıiİI][gğĞ][ıiİI]m\s+(?:do[gğĞ]rula\s+)?([a-z2-9]{4})-?([a-z2-9]{4})\s*$/i;

/**
 * Özel mesajın tamamı numara doğrulama kodu mu ("kiraligim doğrula XXXX-XXXX")? Evet ise normalize
 * kod (8 büyük harf). "doğrula" sözcüğü isteğe bağlıdır.
 */
export function parseVerifyMessage(text: string): string | null {
  const m = VERIFY_MESSAGE_RE.exec(text);
  if (!m) return null;
  const code = `${m[1]}${m[2]}`.toUpperCase();
  return [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

export type GroupSync = {
  jid: string;
  subject: string | null;
  participants: number;
  botIsAdmin: boolean;
  adminsOnly: boolean;
};

/** Grubun sahiplik ipuçları: numara (PN) biliniyorsa o, yoksa çözülmek üzere gizli kimlik (LID). */
export type GroupPeople = {
  addedBy: { pn: string | null; lid: string | null };
  owner: { pn: string | null; lid: string | null };
};

type ParticipantLike = {
  id?: string | null;
  lid?: string | null;
  phoneNumber?: string | null;
  admin?: "admin" | "superadmin" | null;
};
export type GroupMetaLike = {
  id: string;
  subject?: string | null;
  announce?: boolean;
  size?: number;
  participants?: ParticipantLike[];
  owner?: string | null;
  ownerPn?: string | null;
  /** Asistanı gruba ekleyen kişi (yalnız katılım bildiriminde gelir). */
  author?: string | null;
  authorPn?: string | null;
};

/** "905321112233:7@s.whatsapp.net" → "905321112233"; telefon JID'i değilse null. */
export function pnFromJid(jid: string | null | undefined): string | null {
  if (!jid || !isPnUser(jid)) return null;
  const user = jidNormalizedUser(jid).split("@")[0] ?? "";
  return /^[1-9][0-9]{6,19}$/.test(user) ? user : null;
}

/** Bir kişinin (author/owner) numarası ve gizli kimliği. */
export function personOf(
  jid: string | null | undefined,
  pnJid: string | null | undefined,
): { pn: string | null; lid: string | null } {
  const pn = pnFromJid(pnJid) ?? pnFromJid(jid);
  const lid = jid && isLidUser(jid) ? jidNormalizedUser(jid) : null;
  return { pn, lid: pn ? null : lid };
}

/** Bağlı hesabın kimlikleri: telefon JID'i ve (varsa) LID'i, cihaz eki olmadan. */
export function selfIds(user: { id?: string | null; lid?: string | null } | undefined): string[] {
  const out: string[] = [];
  for (const j of [user?.id, user?.lid]) if (j) out.push(jidNormalizedUser(j));
  return out;
}

export function toGroupSync(meta: GroupMetaLike, self: string[]): GroupSync {
  const parts = meta.participants ?? [];
  const me = parts.find((p) =>
    [p.id, p.lid, p.phoneNumber].some((j) => j && self.includes(jidNormalizedUser(j))),
  );
  return {
    jid: meta.id,
    subject: meta.subject?.trim() ? meta.subject.trim().slice(0, 200) : null,
    participants: meta.size ?? parts.length,
    botIsAdmin: me?.admin === "admin" || me?.admin === "superadmin",
    adminsOnly: meta.announce === true,
  };
}

/** Grup kurucusu ve (bildirimde varsa) asistanı ekleyen kişi. */
export function groupPeople(meta: GroupMetaLike): GroupPeople {
  return {
    addedBy: personOf(meta.author, meta.authorPn),
    owner: personOf(meta.owner, meta.ownerPn),
  };
}

const involvesSelf = (participants: (ParticipantLike | string)[], self: string[]) =>
  participants.some((p) => {
    const ids = typeof p === "string" ? [p] : [p.id, p.lid, p.phoneNumber];
    return ids.some((j) => j && self.includes(jidNormalizedUser(j)));
  });

/** group-participants.update: bağlı hesap gruptan çıkarıldı mı? */
export function selfRemoved(
  action: string,
  participants: (ParticipantLike | string)[],
  self: string[],
): boolean {
  return action === "remove" && involvesSelf(participants, self);
}

/** group-participants.update: bağlı hesap gruba eklendi mi? (ekleyen: olayın author'u) */
export function selfAdded(
  action: string,
  participants: (ParticipantLike | string)[],
  self: string[],
): boolean {
  return action === "add" && involvesSelf(participants, self);
}
