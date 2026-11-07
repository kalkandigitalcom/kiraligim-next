import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";

import { PG, pgErrorInfo } from "@/db/pg-error";
import type { MemberRole, TenantContext, Tx } from "@/db/tenant";
import { AppError, forbidden, validationError } from "@/lib/errors";
import { POOL_KINDS, type PropertyStatus, type PropertyType } from "@/lib/property-meta";
import { plainTextToHtml } from "@/lib/rich-text";
import { zodFieldErrors } from "@/lib/result";
import { type PROPERTY_AUDIT_FIELDS, recordAudit } from "@/server/audit/record";
import {
  ALLOWANCE_MESSAGES,
  evaluatePropertyAllowance,
  getEntitlements,
  type PropertyAllowance,
} from "@/server/billing/entitlements";

import { sanitizeDescription } from "./description";
import {
  type PoolsInput,
  poolsFromRaw,
  parsePropertyInput,
  type PropertyInput,
  propertyStatusInput,
} from "./schema";

/**
 * Mülk servisi. TÜM fonksiyonlar withTenant içinden (tx + ctx) çağrılır:
 *  - workspace_id ve created_by istemciden değil, transaction bağlamından gelir;
 *  - RLS (FORCE) başka işletmenin satırlarını gizler ve yazmayı engeller;
 *  - uygulama tarafındaki rol ve limit denetimi yalnız anlaşılır hata içindir, asıl engel
 *    veritabanıdır (politikalar + properties_enforce_limit tetikleyicisi).
 */

export const PROPERTY_MANAGER_ROLES: readonly MemberRole[] = ["owner", "manager"];
export const canManageProperties = (role: MemberRole) => PROPERTY_MANAGER_ROLES.includes(role);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID_RE.test(v);

export type PropertySummary = {
  id: string;
  name: string;
  propertyType: PropertyType;
  status: PropertyStatus;
  maxGuests: number;
  bedrooms: number;
  bathrooms: number;
  province: string;
  district: string;
};

/** Liste görünümü: özet + kapak fotoğrafının depolama öneki (yoksa null). */
export type PropertyListItem = PropertySummary & { coverPrefix: string | null };

export type PropertyPool = {
  present: boolean;
  depth: number | null;
  width: number | null;
  length: number | null;
};
export type PropertyPools = PoolsInput;

export type Property = PropertySummary & {
  /** Düz metin açıklama. */
  description: string | null;
  /** Gösterim/düzenleme için temiz HTML (eski düz metin kayıtlar için üretilmiş). */
  descriptionHtml: string | null;
  tourismLicenseNo: string | null;
  youtubeVideoIds: string[];
  pools: PropertyPools;
  bedsDouble: number;
  bedsSingle: number;
  bedsSofa: number;
  countryCode: string;
  neighborhood: string | null;
  addressLine: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  createdAt: Date;
  updatedAt: Date;
};

type Row = {
  id: string;
  name: string;
  property_type: PropertyType;
  status: PropertyStatus;
  max_guests: number;
  bedrooms: number;
  bathrooms: number;
  province: string;
  district: string;
  description: string | null;
  beds_double: number;
  beds_single: number;
  beds_sofa: number;
  country_code: string;
  neighborhood: string | null;
  address_line: string | null;
  postal_code: string | null;
  latitude: string | null;
  longitude: string | null;
  description_html: string | null;
  tourism_license_no: string | null;
  youtube_video_ids: string[] | null;
  pool_swimming: boolean;
  pool_swimming_depth: string | null;
  pool_swimming_width: string | null;
  pool_swimming_length: string | null;
  pool_swimming_protected: boolean;
  pool_indoor: boolean;
  pool_indoor_depth: string | null;
  pool_indoor_width: string | null;
  pool_indoor_length: string | null;
  pool_kids: boolean;
  pool_kids_depth: string | null;
  pool_kids_width: string | null;
  pool_kids_length: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const toSummary = (r: Row): PropertySummary => ({
  id: r.id,
  name: r.name,
  propertyType: r.property_type,
  status: r.status,
  maxGuests: r.max_guests,
  bedrooms: r.bedrooms,
  bathrooms: r.bathrooms,
  province: r.province,
  district: r.district,
});

const num = (v: string | null) => (v === null ? null : Number(v));

/** Kayıttaki açıklama HTML'i; yoksa (biçimlendirme öncesi kayıt) düz metinden üretilir. */
function storedDescriptionHtml(r: Row): string | null {
  if (r.description_html) return r.description_html;
  if (!r.description) return null;
  return sanitizeDescription(plainTextToHtml(r.description))?.html ?? null;
}

function rowPools(r: Row): PropertyPools {
  const pool = (k: "swimming" | "indoor" | "kids"): PropertyPool => ({
    present: r[`pool_${k}`],
    depth: num(r[`pool_${k}_depth`]),
    width: num(r[`pool_${k}_width`]),
    length: num(r[`pool_${k}_length`]),
  });
  return {
    swimming: pool("swimming"),
    indoor: pool("indoor"),
    kids: pool("kids"),
    swimmingProtected: r.pool_swimming_protected,
  };
}

const toProperty = (r: Row): Property => ({
  ...toSummary(r),
  description: r.description,
  descriptionHtml: storedDescriptionHtml(r),
  tourismLicenseNo: r.tourism_license_no,
  youtubeVideoIds: r.youtube_video_ids ?? [],
  pools: rowPools(r),
  bedsDouble: r.beds_double,
  bedsSingle: r.beds_single,
  bedsSofa: r.beds_sofa,
  countryCode: r.country_code,
  neighborhood: r.neighborhood,
  addressLine: r.address_line,
  postalCode: r.postal_code,
  latitude: r.latitude === null ? null : Number(r.latitude),
  longitude: r.longitude === null ? null : Number(r.longitude),
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
});

/** Bağlamdaki işletmenin mülkleri: aktifler önce, sonra ada göre; kapak fotoğrafıyla. */
export async function listProperties(tx: Tx): Promise<PropertyListItem[]> {
  const res = await tx.execute<Row & { cover_prefix: string | null }>(sql`
    select p.id, p.name, p.property_type, p.status, p.max_guests, p.bedrooms, p.bathrooms,
           p.province, p.district, c.storage_prefix as cover_prefix
      from properties p
      left join property_photos c
        on c.property_id = p.id and c.workspace_id = p.workspace_id and c.is_cover
     where p.workspace_id = app_current_workspace_id()
     order by (p.status = 'active') desc, p.name collate "C", p.created_at`);
  return res.rows.map((r) => ({ ...toSummary(r), coverPrefix: r.cover_prefix }));
}

/** Tek mülk; başka işletmeye aitse veya yoksa null (RLS satırı göstermez). */
export async function getProperty(tx: Tx, id: string): Promise<Property | null> {
  if (!isUuid(id)) return null;
  const res = await tx.execute<Row>(sql`
    select * from properties where id = ${id} and workspace_id = app_current_workspace_id()`);
  const row = res.rows[0];
  return row ? toProperty(row) : null;
}

export type PropertyUsage = PropertyAllowance & { planName: string | null };

/** Kullanım göstergesi: aktif + pasif tüm mülkler sayılır. */
export async function getPropertyUsage(tx: Tx): Promise<PropertyUsage> {
  // Aynı transaction bağlantısında sorgular sıralı çalışır (pg aynı anda tek sorgu).
  const entitlements = await getEntitlements(tx);
  const countRes = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from properties where workspace_id = app_current_workspace_id()`,
  );
  const used = countRes.rows[0]?.n ?? 0;
  return {
    ...evaluatePropertyAllowance(entitlements, used),
    planName: entitlements?.planName ?? null,
  };
}

function parseInput(input: unknown): PropertyInput {
  const parsed = parsePropertyInput(input);
  if (!parsed.success) throw validationError(zodFieldErrors(parsed.error));
  return parsed.data;
}

/** Veritabanı hatalarını kullanıcıya gösterilebilir uygulama hatalarına çevirir. */
function mapWriteError(err: unknown): never {
  const pg = pgErrorInfo(err);
  if (pg.code === PG.INSUFFICIENT_PRIVILEGE) throw forbidden();
  switch (pg.message) {
    case "property_limit_reached":
      throw new AppError("LIMIT_REACHED", ALLOWANCE_MESSAGES.limit_reached);
    case "property_subscription_inactive":
      throw new AppError("LIMIT_REACHED", ALLOWANCE_MESSAGES.subscription_inactive);
    case "property_subscription_missing":
      throw new AppError("LIMIT_REACHED", ALLOWANCE_MESSAGES.no_subscription);
  }
  if (pg.code === PG.CHECK_VIOLATION) {
    throw validationError({}, "Girilen değerlerden biri geçerli aralıkta değil.");
  }
  throw err;
}

const columnsOf = (v: PropertyInput) => ({
  name: v.name,
  property_type: v.propertyType,
  description: v.description?.text ?? null,
  description_html: v.description?.html ?? null,
  tourism_license_no: v.tourismLicenseNo ?? null,
  youtube_video_ids: v.youtubeUrls,
  pools: poolsFromRaw(v),
  max_guests: v.maxGuests,
  bedrooms: v.bedrooms,
  bathrooms: v.bathrooms,
  beds_double: v.bedsDouble,
  beds_single: v.bedsSingle,
  beds_sofa: v.bedsSofa,
  province: v.province,
  district: v.district,
  neighborhood: v.neighborhood ?? null,
  address_line: v.addressLine ?? null,
  postal_code: v.postalCode ?? null,
  latitude: v.latitude ?? null,
  longitude: v.longitude ?? null,
});

/** Yeni mülk (owner/manager). Limit ve abonelik, eklemeden önce ve veritabanında denetlenir. */
export async function createProperty(tx: Tx, ctx: TenantContext, input: unknown): Promise<string> {
  if (!canManageProperties(ctx.role)) throw forbidden();
  const v = parseInput(input);
  const usage = await getPropertyUsage(tx);
  if (!usage.allowed) throw new AppError("LIMIT_REACHED", ALLOWANCE_MESSAGES[usage.reason]);

  const id = uuidv7();
  const c = columnsOf(v);
  try {
    await tx.execute(sql`savepoint create_property`);
    await tx.execute(sql`
      insert into properties (
        id, workspace_id, created_by, name, property_type, description,
        max_guests, bedrooms, bathrooms, beds_double, beds_single, beds_sofa,
        province, district, neighborhood, address_line, postal_code, latitude, longitude,
        description_html, tourism_license_no, youtube_video_ids,
        pool_swimming, pool_swimming_depth, pool_swimming_width, pool_swimming_length,
        pool_swimming_protected,
        pool_indoor, pool_indoor_depth, pool_indoor_width, pool_indoor_length,
        pool_kids, pool_kids_depth, pool_kids_width, pool_kids_length)
      values (
        ${id}, app_current_workspace_id(), app_current_user_id(), ${c.name}, ${c.property_type},
        ${c.description}, ${c.max_guests}, ${c.bedrooms}, ${c.bathrooms}, ${c.beds_double},
        ${c.beds_single}, ${c.beds_sofa}, ${c.province}, ${c.district}, ${c.neighborhood},
        ${c.address_line}, ${c.postal_code}, ${c.latitude}, ${c.longitude},
        ${c.description_html}, ${c.tourism_license_no}, ${sql.param(c.youtube_video_ids)}::text[],
        ${poolValues(c.pools)})`);
    await tx.execute(sql`release savepoint create_property`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint create_property`);
    mapWriteError(err);
  }
  await recordAudit(tx, {
    action: "property.created",
    targetType: "property",
    targetId: id,
    metadata: { type: v.propertyType },
  });
  return id;
}

/** Havuz kolonlarının değerleri, INSERT/UPDATE kolon sırasıyla. */
function poolValues(p: PropertyPools) {
  const vals: unknown[] = [];
  for (const k of POOL_KINDS) {
    vals.push(p[k].present, p[k].depth, p[k].width, p[k].length);
    if (k === "swimming") vals.push(p.swimmingProtected);
  }
  return sql.join(
    vals.map((v) => sql`${v}`),
    sql`, `,
  );
}

const samePools = (a: PropertyPools, b: PropertyPools) =>
  a.swimmingProtected === b.swimmingProtected &&
  POOL_KINDS.every(
    (k) =>
      a[k].present === b[k].present &&
      a[k].depth === b[k].depth &&
      a[k].width === b[k].width &&
      a[k].length === b[k].length,
  );

/** Değişen alanların adları (denetim kaydı için; değerler yazılmaz). */
function changedFields(
  before: Property,
  c: ReturnType<typeof columnsOf>,
): (typeof PROPERTY_AUDIT_FIELDS)[number][] {
  const out: (typeof PROPERTY_AUDIT_FIELDS)[number][] = [];
  const pairs: [(typeof PROPERTY_AUDIT_FIELDS)[number], unknown, unknown][] = [
    ["name", before.name, c.name],
    ["property_type", before.propertyType, c.property_type],
    ["description", before.descriptionHtml, c.description_html],
    ["tourism_license_no", before.tourismLicenseNo, c.tourism_license_no],
    ["youtube_videos", before.youtubeVideoIds.join(","), c.youtube_video_ids.join(",")],
    ["max_guests", before.maxGuests, c.max_guests],
    ["bedrooms", before.bedrooms, c.bedrooms],
    ["bathrooms", before.bathrooms, c.bathrooms],
    ["beds_double", before.bedsDouble, c.beds_double],
    ["beds_single", before.bedsSingle, c.beds_single],
    ["beds_sofa", before.bedsSofa, c.beds_sofa],
    ["province", before.province, c.province],
    ["district", before.district, c.district],
    ["neighborhood", before.neighborhood, c.neighborhood],
    ["address_line", before.addressLine, c.address_line],
    ["postal_code", before.postalCode, c.postal_code],
  ];
  for (const [field, a, b] of pairs) if (a !== b) out.push(field);
  if (before.latitude !== c.latitude || before.longitude !== c.longitude) out.push("coordinates");
  if (!samePools(before.pools, c.pools)) out.push("pools");
  return out;
}

/** Mülkü düzenler (owner/manager). Deneme süresi dolmuş olsa da düzenleme serbesttir. */
export async function updateProperty(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  input: unknown,
): Promise<{ changed: number }> {
  if (!canManageProperties(ctx.role)) throw forbidden();
  const v = parseInput(input);
  if (!isUuid(id)) throw new AppError("NOT_FOUND", "Mülk bulunamadı.");
  const c = columnsOf(v);
  let fields: (typeof PROPERTY_AUDIT_FIELDS)[number][] = [];
  try {
    await tx.execute(sql`savepoint update_property`);
    const cur = await tx.execute<Row>(sql`
      select * from properties where id = ${id} and workspace_id = app_current_workspace_id()
         for update`);
    const before = cur.rows[0];
    if (!before) throw new AppError("NOT_FOUND", "Mülk bulunamadı.");
    fields = changedFields(toProperty(before), c);
    if (fields.length > 0) {
      const res = await tx.execute(sql`
        update properties set
          name = ${c.name}, property_type = ${c.property_type}, description = ${c.description},
          max_guests = ${c.max_guests}, bedrooms = ${c.bedrooms}, bathrooms = ${c.bathrooms},
          beds_double = ${c.beds_double}, beds_single = ${c.beds_single}, beds_sofa = ${c.beds_sofa},
          province = ${c.province}, district = ${c.district}, neighborhood = ${c.neighborhood},
          address_line = ${c.address_line}, postal_code = ${c.postal_code},
          latitude = ${c.latitude}, longitude = ${c.longitude},
          description_html = ${c.description_html}, tourism_license_no = ${c.tourism_license_no},
          youtube_video_ids = ${sql.param(c.youtube_video_ids)}::text[],
          (pool_swimming, pool_swimming_depth, pool_swimming_width, pool_swimming_length,
           pool_swimming_protected,
           pool_indoor, pool_indoor_depth, pool_indoor_width, pool_indoor_length,
           pool_kids, pool_kids_depth, pool_kids_width, pool_kids_length) = (${poolValues(c.pools)})
        where id = ${id} and workspace_id = app_current_workspace_id()`);
      if (res.rowCount !== 1) throw new AppError("NOT_FOUND", "Mülk bulunamadı.");
    }
    await tx.execute(sql`release savepoint update_property`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint update_property`);
    if (err instanceof AppError) throw err;
    mapWriteError(err);
  }
  if (fields.length > 0) {
    await recordAudit(tx, {
      action: "property.updated",
      targetType: "property",
      targetId: id,
      metadata: { fields },
    });
  }
  return { changed: fields.length };
}

/** Aktif / pasif (owner/manager). Silme yoktur. Pasif mülk de paket limitine dahildir. */
export async function setPropertyStatus(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  status: unknown,
): Promise<{ changed: boolean }> {
  if (!canManageProperties(ctx.role)) throw forbidden();
  const to = propertyStatusInput.safeParse(status);
  if (!to.success) throw validationError({ status: ["Geçersiz durum."] });
  if (!isUuid(id)) throw new AppError("NOT_FOUND", "Mülk bulunamadı.");
  let from: PropertyStatus | undefined;
  try {
    await tx.execute(sql`savepoint property_status`);
    const cur = await tx.execute<{ status: PropertyStatus }>(sql`
      select status from properties where id = ${id} and workspace_id = app_current_workspace_id()
         for update`);
    from = cur.rows[0]?.status;
    if (!from) throw new AppError("NOT_FOUND", "Mülk bulunamadı.");
    if (from !== to.data) {
      const res = await tx.execute(sql`
        update properties set status = ${to.data}
         where id = ${id} and workspace_id = app_current_workspace_id() and status = ${from}`);
      if (res.rowCount !== 1) {
        throw new AppError("CONFLICT", "Mülk durumu değiştirilemedi; lütfen tekrar deneyin.");
      }
    }
    await tx.execute(sql`release savepoint property_status`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint property_status`);
    if (err instanceof AppError) throw err;
    mapWriteError(err);
  }
  if (from === to.data) return { changed: false };
  await recordAudit(tx, {
    action: "property.status_changed",
    targetType: "property",
    targetId: id,
    metadata: { from: from!, to: to.data },
  });
  return { changed: true };
}
