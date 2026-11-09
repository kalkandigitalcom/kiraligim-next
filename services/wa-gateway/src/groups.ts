/**
 * A1: grup meta verisinin veritabanı kaydına çevrilmesi ve bağlama kodu mesajının tanınması
 * (saf fonksiyonlar). Kod biçimi src/lib/whatsapp-meta.ts ile AYNIDIR; iki taraf aynı test
 * vektörleriyle denetlenir.
 */
import { jidNormalizedUser } from "baileys";

const LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LINK_MESSAGE_RE = /^\s*k[ıiİI]ral[ıiİI][gğĞ][ıiİI]m\s+([a-z2-9]{4})-?([a-z2-9]{4})\s*$/i;

/** Mesajın tamamı bağlama kodu mu? Evet ise normalize kod (8 büyük harf). */
export function parseLinkMessage(text: string): string | null {
  const m = LINK_MESSAGE_RE.exec(text);
  if (!m) return null;
  const code = `${m[1]}${m[2]}`.toUpperCase();
  return [...code].every((c) => LINK_CODE_ALPHABET.includes(c)) ? code : null;
}

export type GroupSync = {
  jid: string;
  subject: string | null;
  participants: number;
  botIsAdmin: boolean;
  adminsOnly: boolean;
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
};

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

/** group-participants.update: bağlı hesap gruptan çıkarıldı mı? */
export function selfRemoved(
  action: string,
  participants: (ParticipantLike | string)[],
  self: string[],
): boolean {
  if (action !== "remove") return false;
  return participants.some((p) => {
    const ids = typeof p === "string" ? [p] : [p.id, p.lid, p.phoneNumber];
    return ids.some((j) => j && self.includes(jidNormalizedUser(j)));
  });
}
