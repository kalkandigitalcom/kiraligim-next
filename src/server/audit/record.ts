import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";

import type { Tx } from "@/db/tenant";
import { AppError } from "@/lib/errors";
import { PROPERTY_STATUSES, PROPERTY_TYPES } from "@/lib/property-meta";
import {
  RESERVATION_KINDS,
  RESERVATION_SOURCES,
  RESERVATION_STATUSES,
} from "@/lib/reservation-meta";

/**
 * Denetim kaydı yazımı. Kurallar:
 *  - Yalnız aşağıda tanımlı işlem türleri yazılabilir; her türün metadata şeması sabittir (strict).
 *  - İşlemi yapan (actor) ve workspace, istemciden değil transaction bağlamından alınır
 *    (app_current_user_id / app_current_workspace_id) — başkası adına kayıt yazılamaz.
 *  - Hassas anahtar adları (parola, belirteç, e-posta, telefon, TC kimlik, kart, IP...) reddedilir;
 *    ad-soyad, e-posta gibi kişisel bilgi metadata'ya yazılmaz, yalnız kimlikler (UUID) yazılır.
 *  - Metadata en fazla 2 KB (veritabanı sınırı 4 KB).
 *  - Kayıt değiştirilemez ve silinemez (veritabanı tetikleyicisi).
 */

const role = z.enum(["owner", "manager", "staff"]);
/** Denetim kaydına yazılabilecek mülk alan adları (değerleri değil). */
export const PROPERTY_AUDIT_FIELDS = [
  "name",
  "property_type",
  "description",
  "max_guests",
  "bedrooms",
  "bathrooms",
  "province",
  "district",
  "neighborhood",
  "map",
  "distances",
  "tourism_license_no",
  "youtube_videos",
  "pools",
] as const;
/** Denetim kaydına yazılabilecek rezervasyon alan adları (değerleri değil). */
export const RESERVATION_AUDIT_FIELDS = [
  "source",
  "dates",
  "guest_name",
  "guest_phone",
  "guest_email",
  "guests",
  "amounts",
  "currency",
  "note",
] as const;
/** Denetim kaydına yazılabilecek fiyat dönemi alan adları (tutar DEĞERLERİ yazılmaz). */
export const RATE_AUDIT_FIELDS = [
  "dates",
  "nightly_amount",
  "weekly_amount",
  "currency",
  "min_nights",
  "cleaning_fee",
] as const;
/** Denetim kaydına yazılabilecek villa sayfası alan adları (değerleri değil). */
export const PUBLIC_PROFILE_AUDIT_FIELDS = [
  "public_slug",
  "amenities",
  "check_in_time",
  "check_out_time",
  "house_rules",
  "house_rule_keys",
  "price_includes",
] as const;
/** Denetim kaydına yazılabilecek harici takvim alan adları (değerleri değil). */
export const ICAL_SOURCE_AUDIT_FIELDS = ["name", "url", "is_active"] as const;
const slug = z.string().max(48);

export const AUDIT_ACTIONS = {
  "workspace.created": z.strictObject({ slug }),
  "workspace.updated": z.strictObject({
    fields: z.array(z.enum(["name", "slug", "contact_whatsapp"])).min(1),
  }),
  "workspace.member_added": z.strictObject({ role }),
  "workspace.member_role_changed": z.strictObject({ from: role, to: role }),
  "workspace.member_removed": z.strictObject({ role }),
  // Mülk: yalnız tür, değişen ALAN ADLARI ve durum geçişi; adres/ad gibi değerler yazılmaz
  // (bireysel ev sahibinin adresi kişisel veridir).
  "property.created": z.strictObject({ type: z.enum(PROPERTY_TYPES) }),
  "property.updated": z.strictObject({ fields: z.array(z.enum(PROPERTY_AUDIT_FIELDS)).min(1) }),
  "property.status_changed": z.strictObject({
    from: z.enum(PROPERTY_STATUSES),
    to: z.enum(PROPERTY_STATUSES),
  }),
  // Fotoğraf: yalnız mülk kimliği; dosya adı, boyut veya görsel bilgisi yazılmaz.
  "property.photo_added": z.strictObject({ property: z.uuid() }),
  "property.photo_removed": z.strictObject({ property: z.uuid() }),
  "property.photo_cover_changed": z.strictObject({ property: z.uuid() }),
  "property.photos_reordered": z.strictObject({ property: z.uuid() }),
  // Fiyat dönemi: yalnız mülk kimliği ve değişen ALAN ADLARI; fiyat ve tarih değerleri yazılmaz.
  "property.rate_created": z.strictObject({ property: z.uuid() }),
  "property.rate_updated": z.strictObject({
    property: z.uuid(),
    fields: z.array(z.enum(RATE_AUDIT_FIELDS)).min(1),
  }),
  "property.rate_deleted": z.strictObject({ property: z.uuid() }),
  // Villa sayfası (F1): yalnız değişen ALAN ADLARI ve yayın geçişleri; adres/metin değerleri yazılmaz.
  "property.public_profile_updated": z.strictObject({
    fields: z.array(z.enum(PUBLIC_PROFILE_AUDIT_FIELDS)).min(1),
  }),
  "property.published": z.strictObject({}),
  "property.unpublished": z.strictObject({}),
  // Harici takvim (iCal, 3.1): yalnız mülk kimliği ve değişen ALAN ADLARI; adres (erişim anahtarı
  // içerebilir), kaynak adı ve dışa aktarma belirteci yazılmaz.
  "property.ical_source_added": z.strictObject({ property: z.uuid() }),
  "property.ical_source_updated": z.strictObject({
    property: z.uuid(),
    fields: z.array(z.enum(ICAL_SOURCE_AUDIT_FIELDS)).min(1),
  }),
  "property.ical_source_removed": z.strictObject({ property: z.uuid() }),
  "property.ical_export_rotated": z.strictObject({ property: z.uuid() }),
  // Rezervasyon: misafir adı/telefonu/e-postası ve tutar DEĞERLERİ yazılmaz (kişisel/ticari veri).
  "reservation.created": z.strictObject({
    property: z.uuid(),
    kind: z.enum(RESERVATION_KINDS),
    status: z.enum(RESERVATION_STATUSES),
    source: z.enum(RESERVATION_SOURCES).nullable(),
  }),
  "reservation.updated": z.strictObject({
    property: z.uuid(),
    fields: z.array(z.enum(RESERVATION_AUDIT_FIELDS)).min(1),
  }),
  // WhatsApp Asistanı (A1): grup adı, telefon, kod ve mesaj içeriği yazılmaz. group_linked,
  // group_unlinked ve phone_verified kayıtlarını veritabanı fonksiyonları yazar (drizzle/0031,
  // 0034); burada listelenir. link_code_created ve method "link_code" eski kodlu bağlamadandır.
  "whatsapp.link_code_created": z.strictObject({}),
  "whatsapp.group_linked": z.union([
    z.strictObject({ method: z.literal("link_code") }),
    z.strictObject({ method: z.literal("claim"), property: z.uuid() }),
  ]),
  "whatsapp.group_property_changed": z.strictObject({ property: z.uuid() }),
  "whatsapp.phone_verification_created": z.strictObject({}),
  "whatsapp.phone_verified": z.strictObject({}),
  "whatsapp.phone_removed": z.strictObject({}),
  "whatsapp.group_suspended": z.strictObject({}),
  "whatsapp.group_resumed": z.strictObject({}),
  "whatsapp.group_unlinked": z.strictObject({}),
  "whatsapp.link_manager_granted": z.strictObject({}),
  "whatsapp.link_manager_revoked": z.strictObject({}),
  // A2d: WhatsApp önerisinin panelde kararı. Mesaj metni, misafir adı ve numara yazılmaz.
  "whatsapp.proposal_applied": z.strictObject({
    property: z.uuid(),
    action: z.enum(["reserve", "close"]),
    reservation: z.uuid(),
    edited: z.boolean(),
  }),
  "whatsapp.proposal_rejected": z.strictObject({}),
  "reservation.status_changed": z.strictObject({
    property: z.uuid(),
    from: z.enum(RESERVATION_STATUSES),
    to: z.enum(RESERVATION_STATUSES),
  }),
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export type AuditEntry<A extends AuditAction = AuditAction> = {
  action: A;
  targetType?:
    | "workspace"
    | "workspace_member"
    | "user"
    | "property"
    | "property_photo"
    | "property_rate"
    | "external_calendar_source"
    | "reservation"
    | "whatsapp_group"
    | "whatsapp_link_code"
    | "whatsapp_proposal";
  targetId?: string;
  metadata: z.input<(typeof AUDIT_ACTIONS)[A]>;
};

const SENSITIVE_KEY =
  /pass(word)?|secret|token|cookie|auth|api[-_]?key|e-?mail|phone|telefon|tc_?kimlik|identity|passport|iban|card|kart|ip_?address|^ip$|user_?agent|name$|^ad$|soyad/i;
const MAX_METADATA_BYTES = 2048;

function findSensitiveKey(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const hit = findSensitiveKey(v, `${path}[${i}]`);
      if (hit) return hit;
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) return `${path}${path ? "." : ""}${k}`;
      const hit = findSensitiveKey(v, `${path}${path ? "." : ""}${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

/** Yazmadan önceki doğrulama (birim testlerinde ayrıca sınanır). */
export function validateAuditEntry(entry: AuditEntry): Record<string, unknown> {
  const schema = AUDIT_ACTIONS[entry.action];
  if (!schema)
    throw new AppError("INTERNAL", `Bilinmeyen denetim işlemi: ${entry.action}`, { expose: false });
  const sensitive = findSensitiveKey(entry.metadata);
  if (sensitive) {
    throw new AppError("INTERNAL", `Denetim metadata'sında hassas alan: ${sensitive}`, {
      expose: false,
    });
  }
  const parsed = schema.safeParse(entry.metadata);
  if (!parsed.success) {
    throw new AppError("INTERNAL", `Denetim metadata'sı geçersiz: ${entry.action}`, {
      expose: false,
    });
  }
  const metadata = parsed.data as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_METADATA_BYTES) {
    throw new AppError("INTERNAL", "Denetim metadata'sı çok büyük", { expose: false });
  }
  return metadata;
}

/**
 * Bağlamdaki transaction'a denetim kaydı ekler. withTenant içinde çağrılırsa workspace'e,
 * withUser içinde (workspace bağlamı yokken) çağrılırsa workspace'siz kayıt olur.
 */
export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<string> {
  const metadata = validateAuditEntry(entry);
  const id = uuidv7();
  await tx.execute(sql`
    insert into audit_log (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
    values (${id}, app_current_workspace_id(), app_current_user_id(), ${entry.action},
            ${entry.targetType ?? null}, ${entry.targetId ?? null}, ${JSON.stringify(metadata)}::jsonb)`);
  return id;
}
