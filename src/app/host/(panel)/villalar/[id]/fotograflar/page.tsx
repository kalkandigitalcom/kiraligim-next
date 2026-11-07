import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { photoSources } from "@/server/properties/photo-urls";
import { listPhotos } from "@/server/properties/photos";
import { canManageProperties, getProperty } from "@/server/properties/service";
import { getStorage } from "@/server/storage";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { StatusBadge } from "../../_components/property-bits";
import { PropertyTabs } from "../../_components/property-tabs";
import { type ManagerPhoto, PhotoManager } from "./photo-manager";

export const metadata: Metadata = { title: "Fotoğraflar" };

type Props = { params: Promise<{ id: string }> };

export default async function PropertyPhotosPage({ params }: Props) {
  const { id } = await params;
  // RLS: başka işletmenin mülkü veya geçersiz kimlik → null → 404.
  const view = await withPanelTenant(async (tx, ctx) => {
    const property = await getProperty(tx, id);
    return {
      property,
      photos: property ? await listPhotos(tx, property.id) : [],
      canManage: canManageProperties(ctx.role),
    };
  });
  const p = view.property;
  if (!p) notFound();
  const storage = getStorage();
  const photos: ManagerPhoto[] = view.photos.map((ph) => ({
    id: ph.id,
    isCover: ph.isCover,
    width: ph.width,
    height: ph.height,
    sources: photoSources(storage, ph.storagePrefix),
  }));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Link href="/villalar" className="text-sm font-medium text-turquoise-700 hover:underline">
        ← Mülkler
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">
            {p.name}
          </h1>
          <p className="mt-1 text-[15px] text-muted-foreground">Fotoğraflar</p>
        </div>
        <StatusBadge status={p.status} />
      </div>
      <PropertyTabs propertyId={p.id} active="photos" photoCount={photos.length} />
      <PhotoManager
        propertyId={p.id}
        propertyName={p.name}
        photos={photos}
        canManage={view.canManage}
        storageReady={storage !== null}
      />
    </div>
  );
}
