"use client";

import { Field } from "@/components/ui/field";
import { PROPERTY_LIMITS as L } from "@/lib/property-meta";

import type { WizardValues } from "../../actions";
import { RichTextEditor } from "../rich-text-editor";
import { StepCard } from "./step-card";
import { type WizardAction, WizardFooter, WizardForm, useWizardForm } from "./wizard-form";

export type DescriptionValues = Pick<WizardValues, "description" | "youtubeUrl">;

type Props = {
  action: WizardAction;
  initial: DescriptionValues;
  readOnly: boolean;
  prevHref: string | null;
  nextHref: string | null;
  /** Fotoğraf yöneticisi (kendi işlemleriyle anında kaydeder; formun parçası değildir). */
  photos: React.ReactNode;
};

/** 2. adım: açıklama ve YouTube (formla kaydedilir) + fotoğraflar (anında kaydedilir). */
export function DescriptionStep({ action, initial, readOnly, prevHref, nextHref, photos }: Props) {
  const { state, formAction, pending, v, fe } = useWizardForm(action, initial);
  return (
    <>
      <WizardForm
        id="wizard-form"
        step="aciklama"
        state={state}
        formAction={formAction}
        readOnly={readOnly}
      >
        <StepCard
          id="aciklama-baslik"
          title="Villanızı anlatın"
          description="Misafirler villa sayfasında bu metni okur. Öne çıkan özellikleri, çevreyi ve ulaşımı yazabilirsiniz."
        >
          <RichTextEditor
            // Sunucunun döndürdüğü (temizlenmiş) açıklama farklıysa düzenleyici onunla yeniden kurulur.
            key={v.description}
            id="description"
            name="description"
            label="Açıklama (isteğe bağlı)"
            defaultHtml={v.description}
            maxText={L.descriptionMax}
            error={fe.description}
            readOnly={readOnly}
          />
        </StepCard>
        <StepCard
          id="video-baslik"
          title="Video (isteğe bağlı)"
          description="YouTube'a yüklediğiniz tanıtım videosunun bağlantısını yapıştırın. Bir video eklenebilir."
        >
          <Field
            id="youtubeUrl"
            name="youtubeUrl"
            label="YouTube bağlantısı"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            maxLength={500}
            placeholder="https://www.youtube.com/watch?v=…"
            defaultValue={v.youtubeUrl}
            error={fe.youtubeUrl}
          />
        </StepCard>
      </WizardForm>
      <section
        aria-labelledby="fotograf-baslik"
        className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
        data-testid="wizard-photos"
      >
        <div>
          <h3 id="fotograf-baslik" className="text-base font-semibold text-navy-900">
            Fotoğraflar
          </h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Fotoğraflar yüklendiği anda kaydedilir. Kapak fotoğrafı villa sayfasında ilk görünen
            fotoğraftır.
          </p>
        </div>
        {photos}
      </section>
      <WizardFooter
        formId="wizard-form"
        prevHref={prevHref}
        nextHref={nextHref}
        readOnly={readOnly}
        pending={pending}
      />
    </>
  );
}
