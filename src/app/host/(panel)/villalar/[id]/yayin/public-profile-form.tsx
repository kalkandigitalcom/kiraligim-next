"use client";

import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, TextareaField } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  AMENITY_GROUPS,
  PUBLIC_PROFILE_LIMITS as L,
  SLUG_PROBLEM_MESSAGES,
  slugProblem,
  suggestPublicSlug,
} from "@/lib/public-profile-meta";
import type { PublicProfileFormRaw } from "@/server/properties/public-profile-schema";

import type { PublicProfileFormState } from "./actions";

type Props = {
  action: (state: PublicProfileFormState, data: FormData) => Promise<PublicProfileFormState>;
  initial: PublicProfileFormRaw;
  /** Kayıtlı adres (yayındaki adres değişirken onay için). */
  savedSlug: string | null;
  isPublic: boolean;
  propertyName: string;
  district: string;
  /** Adres önizlemesi için alan adı: "kiraligim.com". */
  publicHost: string;
};

/**
 * Villa sayfası ayarları (owner/manager). Adres önerisi ve biçim uyarısı yalnız kolaylıktır; asıl
 * doğrulama sunucuda ve veritabanındadır (benzersizlik dahil).
 */
export function PublicProfileForm({
  action,
  initial,
  savedSlug,
  isPublic,
  propertyName,
  district,
  publicHost,
}: Props) {
  const hydrated = useHydrated();
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values ?? initial;
  const fe = state.fieldErrors ?? {};
  const [slug, setSlug] = useState(v.publicSlug);
  const [amenities, setAmenities] = useState<Set<string>>(new Set(v.amenities));
  const trimmed = slug.trim().toLowerCase();
  const localProblem = trimmed === "" ? null : slugProblem(trimmed);
  const slugChanging = isPublic && savedSlug !== null && trimmed !== savedSlug;

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 font-semibold text-navy-900">Sayfa adresi</legend>
        <Field
          id="publicSlug"
          name="publicSlug"
          label="Adres"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          maxLength={L.slugMax}
          placeholder="villa-defne-kas"
          error={fe.publicSlug ?? (localProblem ? SLUG_PROBLEM_MESSAGES[localProblem] : undefined)}
          hint={
            <>
              Müşterinin göreceği adres:{" "}
              <span className="font-medium text-navy-900" data-testid="slug-preview">
                {publicHost}/villa/{trimmed || "…"}
              </span>
              . Küçük harf, rakam ve tire; tüm sistemde benzersiz olmalı.
            </>
          }
          labelAside={
            <button
              type="button"
              className="text-sm font-medium text-turquoise-700 hover:underline disabled:opacity-50"
              disabled={!hydrated}
              onClick={() => setSlug(suggestPublicSlug(propertyName, district))}
            >
              Ad ve ilçeden öner
            </button>
          }
        />
        {slugChanging ? (
          <div className="flex flex-col gap-1 rounded-xl border border-amber-500/50 bg-amber-50 p-3">
            <label className="flex items-start gap-2 text-sm text-amber-900">
              <input
                type="checkbox"
                name="confirmSlugChange"
                defaultChecked={v.confirmSlugChange}
                className="mt-0.5 size-4 accent-navy-900"
                data-testid="confirm-slug-change"
              />
              <span>
                Sayfa yayında. Adres değişirse daha önce paylaştığım{" "}
                <strong>
                  {publicHost}/villa/{savedSlug}
                </strong>{" "}
                bağlantısının çalışmayacağını anlıyorum.
              </span>
            </label>
            {fe.confirmSlugChange ? (
              <p className="text-sm text-destructive">{fe.confirmSlugChange}</p>
            ) : null}
          </div>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 font-semibold text-navy-900">
          Olanaklar{" "}
          <span className="font-normal text-muted-foreground">({amenities.size} seçili)</span>
        </legend>
        <p className="-mt-2 text-sm text-muted-foreground">
          Havuzlar, mülk bilgilerindeki havuz alanlarından otomatik gösterilir.
        </p>
        {AMENITY_GROUPS.map((g) => (
          <div
            key={g.key}
            className="flex flex-col gap-2"
            role="group"
            aria-labelledby={`grp-${g.key}`}
          >
            <p id={`grp-${g.key}`} className="text-sm font-medium text-navy-900">
              {g.label}
            </p>
            <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
              {g.items.map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm text-navy-900">
                  <input
                    type="checkbox"
                    name="amenities"
                    value={key}
                    checked={amenities.has(key)}
                    onChange={(e) => {
                      const next = new Set(amenities);
                      if (e.target.checked) next.add(key);
                      else next.delete(key);
                      setAmenities(next);
                    }}
                    className="size-4 accent-navy-900"
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        ))}
        {fe.amenities ? <p className="text-sm text-destructive">{fe.amenities}</p> : null}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 font-semibold text-navy-900">Giriş ve çıkış</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="checkInTime"
            name="checkInTime"
            type="time"
            label="Giriş saati (isteğe bağlı)"
            defaultValue={v.checkInTime}
            error={fe.checkInTime}
            hint="Ör. 16:00"
          />
          <Field
            id="checkOutTime"
            name="checkOutTime"
            type="time"
            label="Çıkış saati (isteğe bağlı)"
            defaultValue={v.checkOutTime}
            error={fe.checkOutTime}
            hint="Ör. 10:00"
          />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 font-semibold text-navy-900">Kurallar ve koşullar</legend>
        <p className="-mt-2 text-sm text-muted-foreground">
          Bu metinler villa sayfasında müşteriye aynen gösterilir. Düz metin yazın; telefon veya
          e-posta paylaşmak istemiyorsanız eklemeyin.
        </p>
        <TextareaField
          id="houseRules"
          name="houseRules"
          label="Ev kuralları (isteğe bağlı)"
          defaultValue={v.houseRules}
          maxLength={L.houseRulesMax}
          error={fe.houseRules}
          placeholder="Ör. Evcil hayvan kabul edilmez. 23:00'ten sonra yüksek sesle müzik yapılmaz."
        />
        <TextareaField
          id="cancellationPolicy"
          name="cancellationPolicy"
          label="İptal koşulları (isteğe bağlı)"
          defaultValue={v.cancellationPolicy}
          maxLength={L.cancellationPolicyMax}
          error={fe.cancellationPolicy}
          placeholder="Ör. Girişten 30 gün öncesine kadar yapılan iptallerde ön ödeme iade edilir."
        />
        <TextareaField
          id="paymentTerms"
          name="paymentTerms"
          label="Ön ödeme ve ödeme koşulları (isteğe bağlı)"
          defaultValue={v.paymentTerms}
          maxLength={L.paymentTermsMax}
          error={fe.paymentTerms}
          placeholder="Ör. Rezervasyon onayında toplam tutarın %30'u ön ödeme olarak alınır."
        />
      </fieldset>

      <div className="flex justify-end border-t border-border pt-4">
        <Button type="submit" disabled={!hydrated || pending}>
          {pending ? "Kaydediliyor…" : "Kaydet"}
        </Button>
      </div>
    </form>
  );
}
