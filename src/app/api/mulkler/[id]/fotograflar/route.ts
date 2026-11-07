import { getDb } from "@/db/client";
import { getEnv } from "@/lib/env";
import { getSessionUser } from "@/server/auth/session";
import { createPhotoUploadHandler, type UploadActor } from "@/server/properties/photo-upload";
import { getStorage } from "@/server/storage";
import { resolveActiveWorkspace } from "@/server/workspaces/active";

/** Mülk fotoğrafı yükleme. Tüm denetimler: src/server/properties/photo-upload.ts */
export const dynamic = "force-dynamic";
// sharp yerel modülü: yalnız Node.js çalışma ortamı.
export const runtime = "nodejs";

async function resolveActor(): Promise<UploadActor> {
  const user = await getSessionUser();
  if (!user) return { kind: "unauthenticated" };
  const active = await resolveActiveWorkspace(user.id);
  if (active.kind !== "selected") return { kind: "no_workspace" };
  return { kind: "ok", userId: user.id, workspaceId: active.workspace.id };
}

let handler: ReturnType<typeof createPhotoUploadHandler> | undefined;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  handler ??= createPhotoUploadHandler({
    appUrl: getEnv().APP_URL,
    db: getDb(),
    getStorage,
    resolveActor,
  });
  const { id } = await params;
  return handler(request, id);
}
