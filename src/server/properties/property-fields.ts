import { sql } from "drizzle-orm";

import type { TenantContext, Tx } from "@/db/tenant";
import { AppError, forbidden } from "@/lib/errors";
import { formatMeters, POOL_KINDS } from "@/lib/property-meta";
import { type EditStep, STEP_PROPERTY_FIELDS, STEP_STAY_FIELDS } from "@/lib/property-wizard";
import { DISTANCE_KEYS, distanceToInput } from "@/lib/villa-extras";
import { youtubeWatchUrl } from "@/lib/youtube";

import { getPublicProfile, type PublicProfile, updateStayDetails } from "./public-profile";
import {
  STAY_LIST_FIELDS,
  STAY_TEXT_FIELDS,
  type StayDetailsFormRaw,
} from "./public-profile-schema";
import { PROPERTY_FIELDS, type PropertyField, type PropertyFormRaw } from "./schema";
import { canManageProperties, getProperty, isUuid, type Property, updateProperty } from "./service";

/**
 * Mülk bilgilerini PARÇA PARÇA kaydetme (panel yeniden tasarımı, Aşama 2 → Aşama 3 sihirbazı).
 *
 * Mevcut `updateProperty` tüm mülk alanlarını birlikte bekler ve doğrular. Sihirbazın her adımı
 * yalnız kendi alanlarını gönderir; burada kayıttaki değerler aynı form biçimine çevrilir
 * (`propertyToRaw`, kayıpsız), gelen alanlar üzerine yazılır ve sonuç DEĞİŞMEYEN `updateProperty`
 * doğrulamasından, yetki ve denetim kaydından geçer. Böylece bir adımı kaydetmek diğer alanları
 * değiştirmez; değişmeyen alanlar denetim kaydına yazılmaz.
 */

const KEY = { swimming: "Swimming", indoor: "Indoor", kids: "Kids" } as const;
const meters = (n: number | null) => (n === null ? "" : formatMeters(n));

/**
 * Kayıt → form değerleri (düzenleme formu ve parça kayıt aynı çeviriyi kullanır).
 * Açıklama: kayıtlı temiz HTML; yalnız düz metin olarak kaydedilmiş ESKİ açıklamalar için düz
 * metinden üretilmiş HTML (`Property.descriptionHtml`). Böylece eski açıklama, başka bir alan
 * kaydedilirken boşalmaz. Havuz ölçüleri (2 hane) ve mesafeler veritabanı ölçeğiyle aynı
 * hassasiyette yazılır: gidiş-dönüş değer değiştirmez. Harita: kayıtlı gömme adresi (yeniden
 * ayrıştırıldığında aynı adresi verir). YouTube: tek video (ilk kimlik).
 */
export function propertyToRaw(p: Property): PropertyFormRaw {
  const first = p.youtubeVideoIds[0];
  const out = {
    name: p.name,
    propertyType: p.propertyType,
    description: p.descriptionHtml ?? "",
    tourismLicenseNo: p.tourismLicenseNo ?? "",
    youtubeUrl: first ? youtubeWatchUrl(first) : "",
    maxGuests: String(p.maxGuests),
    bedrooms: String(p.bedrooms),
    bathrooms: String(p.bathrooms),
    province: p.province,
    district: p.district,
    neighborhood: p.neighborhood ?? "",
    mapLocation: p.mapEmbedUrl ?? "",
    poolSwimmingProtected: p.pools.swimmingProtected ? "yes" : "no",
  } as Record<string, unknown>;
  for (const k of DISTANCE_KEYS) out[k] = distanceToInput(p.distances[k]);
  for (const k of POOL_KINDS) {
    const pool = p.pools[k];
    out[`pool${KEY[k]}`] = pool.present ? "yes" : "no";
    out[`pool${KEY[k]}Depth`] = meters(pool.depth);
    out[`pool${KEY[k]}Width`] = meters(pool.width);
    out[`pool${KEY[k]}Length`] = meters(pool.length);
  }
  return out as PropertyFormRaw;
}

/** Gelen nesneden yalnız bilinen mülk alanları (metin) alınır. */
export function pickPropertyFields(input: unknown): Partial<PropertyFormRaw> {
  const out: Partial<PropertyFormRaw> = {};
  if (typeof input !== "object" || input === null) return out;
  const src = input as Record<string, unknown>;
  for (const k of PROPERTY_FIELDS as readonly PropertyField[]) {
    if (typeof src[k] === "string") out[k] = src[k];
  }
  return out;
}

/**
 * Yalnız verilen mülk alanlarını kaydeder (owner/manager). Satır önce kilitlenir; kayıttaki
 * değerlerle birleştirilir ve mevcut `updateProperty` ile doğrulanıp yazılır.
 */
export async function updatePropertyFields(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  input: unknown,
): Promise<{ changed: number }> {
  await lockForWrite(tx, ctx, id);
  const current = await getProperty(tx, id);
  if (!current) throw notFound();
  return updateProperty(tx, ctx, id, { ...propertyToRaw(current), ...pickPropertyFields(input) });
}

const notFound = () => new AppError("NOT_FOUND", "Mülk bulunamadı.");

/** Rol ve kimlik denetimi + satır kilidi (aynı işlemde tekrar kilitlemek sorun değildir). */
async function lockForWrite(tx: Tx, ctx: TenantContext, id: string): Promise<void> {
  if (!canManageProperties(ctx.role)) throw forbidden();
  if (!isUuid(id)) throw notFound();
  const locked = await tx.execute(sql`
    select id from properties where id = ${id} and workspace_id = app_current_workspace_id()
       for update`);
  if (locked.rows.length === 0) throw notFound();
}

/** Kayıtlı olanak ve konaklama bilgileri → form değerleri (boş → ""). */
export function stayToRaw(p: PublicProfile): StayDetailsFormRaw {
  return {
    amenities: [...p.amenities],
    houseRuleKeys: [...p.houseRuleKeys],
    priceIncludes: [...p.priceIncludes],
    checkInTime: p.checkInTime ?? "",
    checkOutTime: p.checkOutTime ?? "",
    houseRules: p.houseRules ?? "",
    cancellationPolicy: p.cancellationPolicy ?? "",
    paymentTerms: p.paymentTerms ?? "",
  };
}

/** Gelen nesneden yalnız seçim listeleri ve konaklama metin alanları alınır. */
export function pickStayFields(input: unknown): Partial<StayDetailsFormRaw> {
  const out: Partial<StayDetailsFormRaw> = {};
  if (typeof input !== "object" || input === null) return out;
  const src = input as Record<string, unknown>;
  for (const k of STAY_TEXT_FIELDS) {
    if (typeof src[k] === "string") out[k] = src[k];
  }
  for (const k of STAY_LIST_FIELDS) {
    const list = src[k];
    if (Array.isArray(list)) out[k] = list.filter((v): v is string => typeof v === "string");
  }
  return out;
}

/**
 * Olanak ve konaklama bilgilerinden YALNIZ verilenleri kaydeder (owner/manager): sihirbazın 3.
 * adımı yalnız olanakları, 4. adımı yalnız saat ve metinleri gönderir. Kayıttaki değerlerle
 * birleştirilir ve mevcut `updateStayDetails` (doğrulama, denetim kaydı) ile yazılır; sayfa adresi
 * ve yayın durumu değişmez.
 */
export async function updateStayFields(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  input: unknown,
): Promise<{ changed: number }> {
  await lockForWrite(tx, ctx, id);
  const current = await getPublicProfile(tx, id);
  if (!current) throw notFound();
  return updateStayDetails(tx, ctx, id, { ...stayToRaw(current), ...pickStayFields(input) });
}

/**
 * Sihirbazın bir adımını kaydeder (owner/manager). Gelen nesneden YALNIZ o adımın alanları
 * alınır: mülk alanları `updatePropertyFields`, olanak/konaklama alanları `updateStayFields` ile
 * yazılır. İkisi aynı işlemdedir; biri hata verirse çağıran işlem (withTenant) geri alınır ve
 * hiçbiri kaydedilmez.
 */
export async function saveWizardStep(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  step: EditStep,
  input: unknown,
): Promise<{ changed: number }> {
  if (!canManageProperties(ctx.role)) throw forbidden();
  const src = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const only = (keys: readonly string[]) =>
    Object.fromEntries(keys.filter((k) => k in src).map((k) => [k, src[k]]));
  const propertyKeys = STEP_PROPERTY_FIELDS[step];
  const stayKeys = STEP_STAY_FIELDS[step];
  let changed = 0;
  if (propertyKeys.length > 0) {
    changed += (await updatePropertyFields(tx, ctx, id, only(propertyKeys))).changed;
  }
  if (stayKeys.length > 0) {
    changed += (await updateStayFields(tx, ctx, id, only(stayKeys))).changed;
  }
  return { changed };
}
