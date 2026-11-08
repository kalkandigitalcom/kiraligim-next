import { sql } from "drizzle-orm";

import { PG, pgErrorInfo } from "@/db/pg-error";
import type { TenantContext, Tx } from "@/db/tenant";
import { AppError, forbidden, validationError } from "@/lib/errors";
import type { PropertyStatus } from "@/lib/property-meta";
import {
  AMENITY_LABELS,
  orderAmenities,
  type PageVisibility,
  pageVisibility,
  PUBLISH_REQUIREMENT_LABELS,
  type PublishRequirement,
  toHhMm,
  unmetRequirements,
} from "@/lib/public-profile-meta";
import { zodFieldErrors } from "@/lib/result";
import {
  HOUSE_RULE_LABELS,
  NO_PETS_RULE,
  orderHouseRules,
  orderPriceIncludes,
  PET_AMENITY,
} from "@/lib/villa-extras";
import { type PUBLIC_PROFILE_AUDIT_FIELDS, recordAudit } from "@/server/audit/record";
import { getEntitlements } from "@/server/billing/entitlements";

import {
  type PublicProfileValues,
  publicProfileInput,
  publicSlugInput,
  stayDetailsInput,
} from "./public-profile-schema";
import { canManageProperties, isUuid } from "./service";

/**
 * Müşteriye açık villa sayfası ayarları (F1). TÜM fonksiyonlar withTenant içinden (tx + ctx)
 * çağrılır; mevcut mülk servisine dokunmaz. Yetki:
 *  - okuma: işletmenin tüm üyeleri (staff dahil; RLS properties_select);
 *  - düzenleme, yayınlama, yayından kaldırma: owner/manager (RLS properties_update + kolon yetkileri
 *    drizzle/0023). Uygulamadaki rol denetimi yalnız anlaşılır hata içindir.
 * Yayın koşulları (src/lib/public-profile-meta.ts) yayınlama anında, kilitli satır üzerinde yeniden
 * hesaplanır.
 */

export type PublicProfile = {
  propertyId: string;
  propertyName: string;
  propertyStatus: PropertyStatus;
  district: string;
  publicSlug: string | null;
  isPublic: boolean;
  publishedAt: Date | null;
  amenities: string[];
  checkInTime: string | null;
  checkOutTime: string | null;
  houseRules: string | null;
  houseRuleKeys: string[];
  priceIncludes: string[];
  photoCount: number;
  /** İşletme düzeyinde (yalnız owner düzenler). */
  whatsapp: string | null;
  subscriptionCurrent: boolean;
  visibility: PageVisibility;
};

type Row = {
  id: string;
  name: string;
  status: PropertyStatus;
  district: string;
  public_slug: string | null;
  is_public: boolean;
  public_published_at: Date | string | null;
  amenities: string[] | null;
  check_in_time: string | null;
  check_out_time: string | null;
  house_rules: string | null;
  house_rule_keys: string[] | null;
  price_includes: string[] | null;
  photo_count: number;
  contact_whatsapp: string | null;
};

const SELECT = sql`
  select p.id, p.name, p.status, p.district, p.public_slug, p.is_public, p.public_published_at,
         p.amenities, p.check_in_time::text as check_in_time, p.check_out_time::text as check_out_time,
         p.house_rules, p.house_rule_keys, p.price_includes,
         (select count(*)::int from property_photos f
           where f.property_id = p.id and f.workspace_id = p.workspace_id) as photo_count,
         (select w.contact_whatsapp from workspaces w where w.id = p.workspace_id) as contact_whatsapp
    from properties p`;

async function subscriptionCurrent(tx: Tx): Promise<boolean> {
  return (await getEntitlements(tx))?.isCurrent ?? false;
}

function toProfile(r: Row, subCurrent: boolean): PublicProfile {
  const base = {
    isPublic: r.is_public,
    propertyActive: r.status === "active",
    slug: r.public_slug,
    photoCount: r.photo_count,
    hasWhatsapp: r.contact_whatsapp !== null,
    subscriptionCurrent: subCurrent,
  };
  return {
    propertyId: r.id,
    propertyName: r.name,
    propertyStatus: r.status,
    district: r.district,
    publicSlug: r.public_slug,
    isPublic: r.is_public,
    publishedAt: r.public_published_at ? new Date(r.public_published_at) : null,
    amenities: orderAmenities(r.amenities ?? []),
    checkInTime: toHhMm(r.check_in_time),
    checkOutTime: toHhMm(r.check_out_time),
    houseRules: r.house_rules,
    houseRuleKeys: orderHouseRules(r.house_rule_keys ?? []).map((x) => x.key),
    priceIncludes: orderPriceIncludes(r.price_includes ?? []).map((x) => x.key),
    photoCount: r.photo_count,
    whatsapp: r.contact_whatsapp,
    subscriptionCurrent: subCurrent,
    visibility: pageVisibility(base),
  };
}

/** Mülkün villa sayfası ayarları; başka işletmeye aitse veya yoksa null (RLS). */
export async function getPublicProfile(tx: Tx, propertyId: string): Promise<PublicProfile | null> {
  if (!isUuid(propertyId)) return null;
  const res = await tx.execute<Row>(sql`${SELECT}
    where p.id = ${propertyId} and p.workspace_id = app_current_workspace_id()`);
  const row = res.rows[0];
  if (!row) return null;
  return toProfile(row, await subscriptionCurrent(tx));
}

const notFoundProperty = () => new AppError("NOT_FOUND", "Mülk bulunamadı.");

function parse(input: unknown): PublicProfileValues {
  const parsed = publicProfileInput.safeParse(input);
  if (!parsed.success) throw validationError(zodFieldErrors(parsed.error));
  return parsed.data;
}

function mapWriteError(err: unknown): never {
  const pg = pgErrorInfo(err);
  if (pg.code === PG.INSUFFICIENT_PRIVILEGE) throw forbidden();
  if (pg.code === PG.UNIQUE_VIOLATION && pg.constraint === "properties_public_slug_key") {
    throw validationError({
      publicSlug: ["Bu adres kullanımda. Sonuna ilçe ya da bir sayı ekleyerek deneyin."],
    });
  }
  if (pg.code === PG.CHECK_VIOLATION) {
    if (pg.constraint === "properties_public_slug_format") {
      throw validationError({ publicSlug: ["Bu adres kullanılamaz."] });
    }
    if (pg.constraint === "properties_public_requires_slug") {
      throw validationError({ publicSlug: ["Yayındaki sayfanın adresi boş bırakılamaz."] });
    }
    throw validationError({}, "Girilen değerlerden biri geçerli aralıkta değil.");
  }
  throw err;
}

type AuditField = (typeof PUBLIC_PROFILE_AUDIT_FIELDS)[number];

/** Birleştirilmiş değerler: listeler her zaman tanımlı. */
type MergedValues = PublicProfileValues & { houseRuleKeys: string[]; priceIncludes: string[] };

const sameSet = (a: readonly string[] | null, b: readonly string[]) =>
  [...(a ?? [])].sort().join(",") === [...b].sort().join(",");

function changedFields(before: Row, v: MergedValues): AuditField[] {
  const out: AuditField[] = [];
  if (before.public_slug !== v.publicSlug) out.push("public_slug");
  if (!sameSet(before.amenities, v.amenities)) out.push("amenities");
  if (!sameSet(before.house_rule_keys, v.houseRuleKeys)) out.push("house_rule_keys");
  if (!sameSet(before.price_includes, v.priceIncludes)) out.push("price_includes");
  if (toHhMm(before.check_in_time) !== v.checkInTime) out.push("check_in_time");
  if (toHhMm(before.check_out_time) !== v.checkOutTime) out.push("check_out_time");
  if (before.house_rules !== v.houseRules) out.push("house_rules");
  return out;
}

async function lockRow(tx: Tx, id: string): Promise<Row> {
  const res = await tx.execute<Row>(sql`${SELECT}
    where p.id = ${id} and p.workspace_id = app_current_workspace_id()
    for update of p`);
  const row = res.rows[0];
  if (!row) throw notFoundProperty();
  return row;
}

/** Kilitli satırdaki mevcut değerler (birleşik ayar biçiminde). */
function currentValues(r: Row): MergedValues {
  return {
    publicSlug: r.public_slug,
    // Kayıttaki dizi olduğu gibi korunur (yeniden sıralama/süzme "değişiklik" sayılmasın).
    amenities: [...(r.amenities ?? [])],
    houseRuleKeys: [...(r.house_rule_keys ?? [])],
    priceIncludes: [...(r.price_includes ?? [])],
    checkInTime: toHhMm(r.check_in_time),
    checkOutTime: toHhMm(r.check_out_time),
    houseRules: r.house_rules,
    confirmSlugChange: false,
  };
}

/**
 * Ortak yazma yolu: satırı kilitler, `next(before)` ile yeni değerleri üretir, adres kurallarını
 * uygular, yalnız değişen alanları denetim kaydına yazar. Tüm public-profile güncellemeleri
 * (birleşik ve ayrık) buradan geçer: kural ve denetim davranışı tek yerdedir.
 */
async function applyProfileUpdate(
  tx: Tx,
  id: string,
  next: (before: Row) => PublicProfileValues,
): Promise<{ changed: number }> {
  let fields: AuditField[] = [];
  try {
    await tx.execute(sql`savepoint public_profile`);
    const before = await lockRow(tx, id);
    // Gönderilmeyen listeler (kurallar, dahil olanlar) kayıttaki değerle tamamlanır.
    const v: MergedValues = { ...currentValues(before), ...next(before) };
    if (v.amenities.includes(PET_AMENITY) && v.houseRuleKeys.includes(NO_PETS_RULE)) {
      const message = `"${HOUSE_RULE_LABELS[NO_PETS_RULE]}" kuralı, Olanaklar'daki "${AMENITY_LABELS[PET_AMENITY]}" seçimiyle çelişiyor; birini kaldırın.`;
      throw validationError({ houseRuleKeys: [message], amenities: [message] });
    }
    const slugChanged = before.public_slug !== v.publicSlug;
    if (before.is_public && slugChanged) {
      if (v.publicSlug === null) {
        throw validationError({
          publicSlug: ["Yayındaki sayfanın adresi boş bırakılamaz; önce yayından kaldırın."],
        });
      }
      if (!v.confirmSlugChange) {
        throw validationError({
          confirmSlugChange: [
            "Sayfa yayında. Adres değişirse daha önce paylaştığınız bağlantı çalışmayacak; onaylayın.",
          ],
        });
      }
    }
    fields = changedFields(before, v);
    if (fields.length > 0) {
      const res = await tx.execute(sql`
        update properties set
          public_slug = ${v.publicSlug},
          amenities = ${sql.param(v.amenities)}::text[],
          house_rule_keys = ${sql.param(v.houseRuleKeys)}::text[],
          price_includes = ${sql.param(v.priceIncludes)}::text[],
          check_in_time = ${v.checkInTime}::time,
          check_out_time = ${v.checkOutTime}::time,
          house_rules = ${v.houseRules}
        where id = ${id} and workspace_id = app_current_workspace_id()`);
      if (res.rowCount !== 1) throw notFoundProperty();
    }
    await tx.execute(sql`release savepoint public_profile`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint public_profile`);
    if (err instanceof AppError) throw err;
    mapWriteError(err);
  }
  if (fields.length > 0) {
    await recordAudit(tx, {
      action: "property.public_profile_updated",
      targetType: "property",
      targetId: id,
      metadata: { fields },
    });
  }
  return { changed: fields.length };
}

/**
 * Villa sayfası ayarlarını birlikte kaydeder (owner/manager): adres + olanaklar + konaklama
 * bilgileri. F1 formu bunu kullanıyordu; uyumluluk için korunur. Yayındaki sayfanın adresi
 * değişiyorsa onay gerekir; yayındaki sayfanın adresi silinemez.
 */
export async function updatePublicProfile(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  input: unknown,
): Promise<{ changed: number }> {
  if (!canManageProperties(ctx.role)) throw forbidden();
  const v = parse(input);
  if (!isUuid(id)) throw notFoundProperty();
  // Birleşik form kurallar/dahil olanlar listesini göndermez: kayıttaki değer korunur.
  return applyProfileUpdate(tx, id, () => v);
}

/**
 * Olanaklar ve konaklama bilgileri (owner/manager): giriş/çıkış saati, ev kuralları, iptal ve
 * ödeme koşulları. Sayfa adresine ve yayın durumuna DOKUNMAZ (mevcut değer korunur).
 */
export async function updateStayDetails(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  input: unknown,
): Promise<{ changed: number }> {
  if (!canManageProperties(ctx.role)) throw forbidden();
  const parsed = stayDetailsInput.safeParse(input);
  if (!parsed.success) throw validationError(zodFieldErrors(parsed.error));
  if (!isUuid(id)) throw notFoundProperty();
  return applyProfileUpdate(tx, id, (before) => ({
    ...currentValues(before),
    ...parsed.data,
  }));
}

/**
 * Yalnız sayfa adresi (owner/manager; Yayın sayfası). Olanak ve konaklama bilgileri korunur.
 * Yayındaki sayfanın adresi değişirken onay ve "boş bırakılamaz" kuralları aynen geçerlidir.
 */
export async function updatePublicSlug(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  input: unknown,
): Promise<{ changed: number }> {
  if (!canManageProperties(ctx.role)) throw forbidden();
  const parsed = publicSlugInput.safeParse(input);
  if (!parsed.success) throw validationError(zodFieldErrors(parsed.error));
  if (!isUuid(id)) throw notFoundProperty();
  return applyProfileUpdate(tx, id, (before) => ({
    ...currentValues(before),
    publicSlug: parsed.data.publicSlug,
    confirmSlugChange: parsed.data.confirmSlugChange,
  }));
}

export const unmetMessage = (unmet: PublishRequirement[]) =>
  `Sayfa yayınlanamadı. Eksik: ${unmet.map((r) => PUBLISH_REQUIREMENT_LABELS[r].toLocaleLowerCase("tr-TR")).join(", ")}.`;

/**
 * Sayfayı yayınlar (owner/manager). Koşullar kilitli satır üzerinde yeniden denetlenir; eksik varsa
 * yayınlanmaz. Zaten yayındaysa değişiklik yapılmaz.
 */
export async function publishProperty(
  tx: Tx,
  ctx: TenantContext,
  id: string,
): Promise<{ changed: boolean }> {
  if (!canManageProperties(ctx.role)) throw forbidden();
  if (!isUuid(id)) throw notFoundProperty();
  const subCurrent = await subscriptionCurrent(tx);
  try {
    await tx.execute(sql`savepoint publish_property`);
    const row = await lockRow(tx, id);
    if (row.is_public) {
      await tx.execute(sql`release savepoint publish_property`);
      return { changed: false };
    }
    const unmet = unmetRequirements({
      isPublic: true,
      propertyActive: row.status === "active",
      slug: row.public_slug,
      photoCount: row.photo_count,
      hasWhatsapp: row.contact_whatsapp !== null,
      subscriptionCurrent: subCurrent,
    });
    if (unmet.length > 0) throw new AppError("CONFLICT", unmetMessage(unmet));
    const res = await tx.execute(sql`
      update properties set is_public = true, public_published_at = now()
       where id = ${id} and workspace_id = app_current_workspace_id() and not is_public`);
    if (res.rowCount !== 1) {
      throw new AppError("CONFLICT", "Sayfa yayınlanamadı; lütfen tekrar deneyin.");
    }
    await tx.execute(sql`release savepoint publish_property`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint publish_property`);
    if (err instanceof AppError) throw err;
    mapWriteError(err);
  }
  await recordAudit(tx, {
    action: "property.published",
    targetType: "property",
    targetId: id,
    metadata: {},
  });
  return { changed: true };
}

/** Sayfayı yayından kaldırır (owner/manager). Bağlantı 404 döner; ayarlar korunur. */
export async function unpublishProperty(
  tx: Tx,
  ctx: TenantContext,
  id: string,
): Promise<{ changed: boolean }> {
  if (!canManageProperties(ctx.role)) throw forbidden();
  if (!isUuid(id)) throw notFoundProperty();
  let changed = false;
  try {
    await tx.execute(sql`savepoint unpublish_property`);
    const row = await lockRow(tx, id);
    if (row.is_public) {
      const res = await tx.execute(sql`
        update properties set is_public = false
         where id = ${id} and workspace_id = app_current_workspace_id() and is_public`);
      changed = res.rowCount === 1;
    }
    await tx.execute(sql`release savepoint unpublish_property`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint unpublish_property`);
    if (err instanceof AppError) throw err;
    mapWriteError(err);
  }
  if (changed) {
    await recordAudit(tx, {
      action: "property.unpublished",
      targetType: "property",
      targetId: id,
      metadata: {},
    });
  }
  return { changed };
}
