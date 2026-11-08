import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-meta";
import {
  nextStep,
  parseWizardStep,
  prevStep,
  stepHref,
  stepIndex,
  WIZARD_STEP_INTROS,
  WIZARD_STEP_LABELS,
  WIZARD_STEPS,
} from "@/lib/property-wizard";
import { photoSources } from "@/server/properties/photo-urls";
import { listPhotos } from "@/server/properties/photos";
import { propertyToRaw, stayToRaw } from "@/server/properties/property-fields";
import { getPublicProfile } from "@/server/properties/public-profile";
import { canManageProperties, getProperty } from "@/server/properties/service";
import { getStorage } from "@/server/storage";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { saveWizardStepAction, setPropertyStatusAction } from "../actions";
import { StatusBadge } from "../_components/property-bits";
import { PropertyTabs } from "../_components/property-tabs";
import { AmenitiesStep } from "../_components/wizard/amenities-step";
import { BasicsStep } from "../_components/wizard/basics-step";
import { DescriptionStep } from "../_components/wizard/description-step";
import { ReviewStep } from "../_components/wizard/review-step";
import { StayStep } from "../_components/wizard/stay-step";
import { WizardStepper } from "../_components/wizard/wizard-stepper";
import { type ManagerPhoto, PhotoManager } from "./fotograflar/photo-manager";

export const metadata: Metadata = { title: "Mülk" };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const NOTICES: Record<string, string> = {
  olusturuldu: "Mülk oluşturuldu. Şimdi villanızı anlatın ve fotoğraflarını ekleyin.",
  kaydedildi: "Bilgiler kaydedildi.",
  pasif: "Mülk pasife alındı.",
  aktif: "Mülk aktif edildi.",
};

/**
 * Mülk bilgileri sihirbazı (Aşama 3). `?adim=` yoksa (mevcut mülk) 5. adım: kontrol ve özet.
 * Her adım yalnız kendi alanlarını kaydeder (saveWizardStepAction). Staff tüm adımları görür,
 * hiçbir şeyi değiştiremez (alanlar devre dışı; yetki ayrıca serviste ve veritabanında).
 */
export default async function PropertyPage({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const step = parseWizardStep(sp.adim);
  // RLS: başka işletmenin mülkü veya geçersiz kimlik → null → 404 (varlık sızdırılmaz).
  const view = await withPanelTenant(async (tx, ctx) => {
    const property = await getProperty(tx, id);
    return {
      property,
      profile: property ? await getPublicProfile(tx, id) : null,
      photos: property && step === "aciklama" ? await listPhotos(tx, property.id) : [],
      canManage: canManageProperties(ctx.role),
    };
  });
  const p = view.property;
  if (!p || !view.profile) notFound();
  const pp = view.profile;
  const readOnly = !view.canManage;
  const notice = typeof sp.durum === "string" ? NOTICES[sp.durum] : undefined;
  const prev = prevStep(step);
  const next = nextStep(step);
  const common = {
    action: saveWizardStepAction.bind(null, p.id, step),
    readOnly,
    prevHref: prev ? stepHref(p.id, prev) : null,
    nextHref: next ? stepHref(p.id, next) : null,
  };
  const raw = propertyToRaw(p);
  const stay = stayToRaw(pp);

  let body: React.ReactNode;
  if (step === "temel") {
    body = <BasicsStep {...common} initial={raw} />;
  } else if (step === "aciklama") {
    const storage = getStorage();
    const photos: ManagerPhoto[] = view.photos.map((ph) => ({
      id: ph.id,
      isCover: ph.isCover,
      width: ph.width,
      height: ph.height,
      sources: photoSources(storage, ph.storagePrefix),
    }));
    body = (
      <DescriptionStep
        {...common}
        initial={{ description: raw.description, youtubeUrls: raw.youtubeUrls }}
        photos={
          <PhotoManager
            propertyId={p.id}
            propertyName={p.name}
            photos={photos}
            canManage={view.canManage}
            storageReady={storage !== null}
          />
        }
      />
    );
  } else if (step === "olanaklar") {
    body = <AmenitiesStep {...common} initial={{ ...raw, amenities: stay.amenities }} />;
  } else if (step === "konaklama") {
    body = <StayStep {...common} initial={stay} />;
  } else {
    body = (
      <ReviewStep
        property={p}
        profile={pp}
        canManage={view.canManage}
        statusAction={setPropertyStatusAction.bind(null, p.id)}
      />
    );
  }

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
          <p className="mt-1 text-[15px] text-muted-foreground">
            {PROPERTY_TYPE_LABELS[p.propertyType]} · {p.district}, {p.province}
          </p>
        </div>
        <StatusBadge status={p.status} />
      </div>
      <PropertyTabs propertyId={p.id} active="info" />

      <WizardStepper propertyId={p.id} current={step} />

      <div>
        <h2 className="text-xl font-bold tracking-tight text-navy-900" data-testid="step-title">
          <span className="sr-only">
            Adım {stepIndex(step) + 1}/{WIZARD_STEPS.length}:{" "}
          </span>
          {WIZARD_STEP_LABELS[step]}
        </h2>
        <p className="mt-1 text-[15px] text-muted-foreground">{WIZARD_STEP_INTROS[step]}</p>
      </div>

      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {readOnly ? (
        <Alert tone="info">
          Bu mülkün bilgilerini görüntülüyorsunuz; düzenleme yetkisi işletme sahibi ve
          yöneticilerdedir.
        </Alert>
      ) : null}

      {/* Adım değişince form durumu sıfırlanır (önceki adımın hatası taşınmaz). */}
      <div key={step} className="flex flex-col gap-6">
        {body}
      </div>
    </div>
  );
}
