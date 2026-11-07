import { sql } from "drizzle-orm";

import { PG, pgErrorInfo } from "@/db/pg-error";
import type { TenantContext, Tx } from "@/db/tenant";
import { AppError, forbidden } from "@/lib/errors";
import { PHOTO_LIMITS, type PhotoWidth } from "@/lib/photo-meta";
import { recordAudit } from "@/server/audit/record";

import { canManageProperties, isUuid } from "./service";

/**
 * Mülk fotoğrafları servisi. TÜM fonksiyonlar withTenant içinden çağrılır:
 *  - workspace_id ve created_by bağlamdan gelir; RLS (FORCE) başka işletmenin fotoğraflarını
 *    gizler, owner/manager dışındaki yazmaları engeller;
 *  - 80 sınırı, sıra ve kapak ataması veritabanı tetikleyicisinde mülk başına kilit altındadır;
 *    kapak / sıra / silme işlemleri de AYNI kilidi (7003) alır → yüklemelerle yarışmaz.
 * Depolama (R2) işlemleri bu dosyada yoktur: yükleme transaction dışında yapılır, silinen
 * nesneler commit sonrasında kaldırılır (route / server action).
 */

export const PHOTO_LIMIT = PHOTO_LIMITS.perProperty;

export const PHOTO_LIMIT_MESSAGE = `Bu mülk için en fazla ${PHOTO_LIMIT} fotoğraf yüklenebilir.`;

/** R2 anahtar öneki: w/{workspace}/p/{property}/{photo}. Tablodaki CHECK ile aynı biçim. */
export function photoPrefix(workspaceId: string, propertyId: string, photoId: string): string {
  for (const id of [workspaceId, propertyId, photoId]) {
    if (!isUuid(id)) throw new AppError("INTERNAL", "Geçersiz kimlik", { expose: false });
  }
  return `w/${workspaceId.toLowerCase()}/p/${propertyId.toLowerCase()}/${photoId.toLowerCase()}`;
}

export const variantKey = (prefix: string, width: PhotoWidth) => `${prefix}/${width}.webp`;

export const variantKeys = (prefix: string) =>
  PHOTO_LIMITS.widths.map((w) => variantKey(prefix, w));

export type PropertyPhoto = {
  id: string;
  storagePrefix: string;
  width: number;
  height: number;
  sortOrder: number;
  isCover: boolean;
  createdAt: Date;
};

type PhotoRow = {
  id: string;
  storage_prefix: string;
  width: number;
  height: number;
  sort_order: number;
  is_cover: boolean;
  created_at: Date | string;
};

const toPhoto = (r: PhotoRow): PropertyPhoto => ({
  id: r.id,
  storagePrefix: r.storage_prefix,
  width: r.width,
  height: r.height,
  sortOrder: r.sort_order,
  isCover: r.is_cover,
  createdAt: new Date(r.created_at),
});

const notFoundPhoto = () => new AppError("NOT_FOUND", "Fotoğraf bulunamadı.");
const notFoundProperty = () => new AppError("NOT_FOUND", "Mülk bulunamadı.");

/** Mülkün fotoğrafları, sıraya göre. Mülk başka işletmenin ise RLS boş liste döndürür. */
export async function listPhotos(tx: Tx, propertyId: string): Promise<PropertyPhoto[]> {
  if (!isUuid(propertyId)) return [];
  const res = await tx.execute<PhotoRow>(sql`
    select id, storage_prefix, width, height, sort_order, is_cover, created_at
      from property_photos
     where property_id = ${propertyId} and workspace_id = app_current_workspace_id()
     order by sort_order, created_at, id`);
  return res.rows.map(toPhoto);
}

async function propertyExists(tx: Tx, propertyId: string): Promise<boolean> {
  const res = await tx.execute<{ ok: number }>(sql`
    select 1 as ok from properties
     where id = ${propertyId} and workspace_id = app_current_workspace_id()`);
  return res.rows.length > 0;
}

async function countPhotos(tx: Tx, propertyId: string): Promise<number> {
  const res = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from property_photos
     where property_id = ${propertyId} and workspace_id = app_current_workspace_id()`);
  return res.rows[0]?.n ?? 0;
}

/**
 * Yükleme öncesi hızlı denetim (görsel işlenmeden ve depolamaya yazılmadan önce): rol, mülk ve
 * sınır. Yalnız anlaşılır hata ve boşa iş yapmamak içindir; asıl engel ekleme tetikleyicisidir.
 */
export async function precheckPhotoUpload(
  tx: Tx,
  ctx: TenantContext,
  propertyId: string,
): Promise<{ count: number }> {
  if (!canManageProperties(ctx.role)) throw forbidden();
  if (!isUuid(propertyId) || !(await propertyExists(tx, propertyId))) throw notFoundProperty();
  const count = await countPhotos(tx, propertyId);
  if (count >= PHOTO_LIMIT) throw new AppError("LIMIT_REACHED", PHOTO_LIMIT_MESSAGE);
  return { count };
}

export type NewPhoto = {
  id: string;
  propertyId: string;
  storagePrefix: string;
  width: number;
  height: number;
  quality: number;
  bytes: Record<PhotoWidth, number>;
};

function mapPhotoWriteError(err: unknown): never {
  const pg = pgErrorInfo(err);
  if (pg.message === "property_photo_limit_reached") {
    throw new AppError("LIMIT_REACHED", PHOTO_LIMIT_MESSAGE);
  }
  if (pg.code === PG.INSUFFICIENT_PRIVILEGE) throw forbidden();
  if (pg.message === "property_photo_property_not_found") throw notFoundProperty();
  // Bileşik FK: mülk yok / başka işletmenin (RLS'ten önce de yakalanır).
  if (pg.code === "23503") throw notFoundProperty();
  throw err;
}

/** Fotoğraf kaydı ekler; sıra ve kapak tetikleyicide (kilit altında) atanır. */
export async function insertPhoto(
  tx: Tx,
  ctx: TenantContext,
  photo: NewPhoto,
): Promise<{ sortOrder: number; isCover: boolean }> {
  if (!canManageProperties(ctx.role)) throw forbidden();
  if (!isUuid(photo.id) || !isUuid(photo.propertyId)) throw notFoundProperty();
  if (photo.storagePrefix !== photoPrefix(ctx.workspaceId, photo.propertyId, photo.id)) {
    throw new AppError("INTERNAL", "Depolama öneki uyuşmuyor", { expose: false });
  }
  let row: { sort_order: number; is_cover: boolean } | undefined;
  try {
    await tx.execute(sql`savepoint insert_photo`);
    const res = await tx.execute<{ sort_order: number; is_cover: boolean }>(sql`
      insert into property_photos (
        id, workspace_id, property_id, created_by, storage_prefix, width, height, quality,
        bytes_400, bytes_1200, bytes_2000)
      values (
        ${photo.id}, app_current_workspace_id(), ${photo.propertyId}, app_current_user_id(),
        ${photo.storagePrefix}, ${photo.width}, ${photo.height}, ${photo.quality},
        ${photo.bytes[400]}, ${photo.bytes[1200]}, ${photo.bytes[2000]})
      returning sort_order, is_cover`);
    row = res.rows[0];
    await tx.execute(sql`release savepoint insert_photo`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint insert_photo`);
    mapPhotoWriteError(err);
  }
  if (!row) throw new AppError("INTERNAL", "Fotoğraf eklenemedi", { expose: false });
  await recordAudit(tx, {
    action: "property.photo_added",
    targetType: "property_photo",
    targetId: photo.id,
    metadata: { property: photo.propertyId },
  });
  return { sortOrder: row.sort_order, isCover: row.is_cover };
}

/** Yükleme tetikleyicisiyle aynı mülk kilidi: kapak/sıra/silme eşzamanlı yüklemelerle yarışmaz. */
async function lockProperty(tx: Tx, propertyId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${propertyId}::text, 7003))`);
}

async function guardWrite(tx: Tx, ctx: TenantContext, propertyId: string, photoId?: string) {
  if (!canManageProperties(ctx.role)) throw forbidden();
  if (!isUuid(propertyId)) throw notFoundProperty();
  if (photoId !== undefined && !isUuid(photoId)) throw notFoundPhoto();
  await lockProperty(tx, propertyId);
}

/** Kapak fotoğrafını değiştirir (tek kapak: kısmi benzersiz indeks). */
export async function setCoverPhoto(
  tx: Tx,
  ctx: TenantContext,
  propertyId: string,
  photoId: string,
): Promise<{ changed: boolean }> {
  await guardWrite(tx, ctx, propertyId, photoId);
  const photos = await listPhotos(tx, propertyId);
  const target = photos.find((p) => p.id === photoId);
  if (!target) throw notFoundPhoto();
  if (target.isCover) return { changed: false };
  try {
    await tx.execute(sql`savepoint photo_cover`);
    await tx.execute(sql`
      update property_photos set is_cover = false
       where property_id = ${propertyId} and workspace_id = app_current_workspace_id()
         and is_cover`);
    const res = await tx.execute(sql`
      update property_photos set is_cover = true
       where id = ${photoId} and property_id = ${propertyId}
         and workspace_id = app_current_workspace_id()`);
    if (res.rowCount !== 1) throw notFoundPhoto();
    await tx.execute(sql`release savepoint photo_cover`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint photo_cover`);
    if (err instanceof AppError) throw err;
    mapPhotoWriteError(err);
  }
  await recordAudit(tx, {
    action: "property.photo_cover_changed",
    targetType: "property_photo",
    targetId: photoId,
    metadata: { property: propertyId },
  });
  return { changed: true };
}

/** Fotoğrafı bir adım yukarı/aşağı taşır; sıra 0..n-1 olarak yeniden numaralanır. */
export async function movePhoto(
  tx: Tx,
  ctx: TenantContext,
  propertyId: string,
  photoId: string,
  direction: "up" | "down",
): Promise<{ changed: boolean }> {
  if (direction !== "up" && direction !== "down") throw notFoundPhoto();
  await guardWrite(tx, ctx, propertyId, photoId);
  const ids = (await listPhotos(tx, propertyId)).map((p) => p.id);
  const i = ids.indexOf(photoId);
  if (i < 0) throw notFoundPhoto();
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= ids.length) return { changed: false };
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  try {
    await tx.execute(sql`savepoint photo_move`);
    await tx.execute(sql`
      update property_photos p set sort_order = (o.ord - 1)::int
        from unnest(array[${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[]) with ordinality as o(id, ord)
       where p.id = o.id and p.property_id = ${propertyId}
         and p.workspace_id = app_current_workspace_id()
         and p.sort_order is distinct from (o.ord - 1)::int`);
    await tx.execute(sql`release savepoint photo_move`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint photo_move`);
    mapPhotoWriteError(err);
  }
  await recordAudit(tx, {
    action: "property.photos_reordered",
    targetType: "property",
    targetId: propertyId,
    metadata: { property: propertyId },
  });
  return { changed: true };
}

/**
 * Fotoğrafı siler. Kapak silinirse sıradaki ilk fotoğraf kapak olur. Silinen kaydın depolama
 * önekini döndürür: nesneler ÇAĞIRAN tarafından, transaction commit edildikten sonra silinir.
 */
export async function deletePhoto(
  tx: Tx,
  ctx: TenantContext,
  propertyId: string,
  photoId: string,
): Promise<{ storagePrefix: string; newCoverId: string | null }> {
  await guardWrite(tx, ctx, propertyId, photoId);
  let removed: { storage_prefix: string; is_cover: boolean } | undefined;
  let newCoverId: string | null = null;
  try {
    await tx.execute(sql`savepoint photo_delete`);
    const res = await tx.execute<{ storage_prefix: string; is_cover: boolean }>(sql`
      delete from property_photos
       where id = ${photoId} and property_id = ${propertyId}
         and workspace_id = app_current_workspace_id()
      returning storage_prefix, is_cover`);
    removed = res.rows[0];
    if (!removed) throw notFoundPhoto();
    if (removed.is_cover) {
      const next = await tx.execute<{ id: string }>(sql`
        update property_photos set is_cover = true
         where id = (select id from property_photos
                      where property_id = ${propertyId}
                        and workspace_id = app_current_workspace_id()
                      order by sort_order, created_at, id
                      limit 1)
        returning id`);
      newCoverId = next.rows[0]?.id ?? null;
    }
    await tx.execute(sql`release savepoint photo_delete`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint photo_delete`);
    if (err instanceof AppError) throw err;
    mapPhotoWriteError(err);
  }
  await recordAudit(tx, {
    action: "property.photo_removed",
    targetType: "property_photo",
    targetId: photoId,
    metadata: { property: propertyId },
  });
  return { storagePrefix: removed!.storage_prefix, newCoverId };
}
