"use server";

import { unstable_rethrow } from "next/navigation";

import { logger } from "@/lib/logger";
import { toActionError } from "@/lib/result";
import { deletePhoto, movePhoto, setCoverPhoto, variantKeys } from "@/server/properties/photos";
import { getStorage } from "@/server/storage";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

/**
 * Fotoğraf server action'ları (kapak, sıra, silme). Kullanıcı ve işletme yalnız oturumdan;
 * istemciden gelen mülk/fotoğraf kimlikleri yetki vermez: RLS başka işletmenin kaydını
 * göstermez, rol (owner/manager) hem serviste hem politikalarda denetlenir.
 */
export type PhotoActionResult = { ok: true } | { ok: false; error: string };

async function run(name: string, fn: () => Promise<unknown>): Promise<PhotoActionResult> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    const r = toActionError(err, { action: name });
    return { ok: false, error: r.ok ? "" : r.error.message };
  }
}

export async function setCoverPhotoAction(
  propertyId: string,
  photoId: string,
): Promise<PhotoActionResult> {
  return run("property.photo_cover", () =>
    withPanelTenant((tx, ctx) => setCoverPhoto(tx, ctx, String(propertyId), String(photoId))),
  );
}

export async function movePhotoAction(
  propertyId: string,
  photoId: string,
  direction: "up" | "down",
): Promise<PhotoActionResult> {
  return run("property.photo_move", () =>
    withPanelTenant((tx, ctx) =>
      movePhoto(tx, ctx, String(propertyId), String(photoId), direction === "up" ? "up" : "down"),
    ),
  );
}

export async function deletePhotoAction(
  propertyId: string,
  photoId: string,
): Promise<PhotoActionResult> {
  let prefix: string | null = null;
  const result = await run("property.photo_delete", async () => {
    const removed = await withPanelTenant((tx, ctx) =>
      deletePhoto(tx, ctx, String(propertyId), String(photoId)),
    );
    prefix = removed.storagePrefix;
  });
  // Kayıt commit edildikten SONRA nesneler silinir; başarısızlık kullanıcıyı etkilemez
  // (yalnız erişilmeyen, sahipsiz nesne kalır — log'a yazılır).
  if (result.ok && prefix) {
    const storage = getStorage();
    if (storage) {
      const settled = await Promise.allSettled(variantKeys(prefix).map((k) => storage.delete(k)));
      const failed = settled.filter((s) => s.status === "rejected").length;
      if (failed > 0) logger.warn("photo_object_delete_failed", { prefix, failed });
    } else {
      logger.warn("photo_object_delete_skipped", { prefix, reason: "storage_not_configured" });
    }
  }
  return result;
}
