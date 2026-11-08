"use client";

import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  PUBLIC_PROFILE_LIMITS as L,
  SLUG_PROBLEM_MESSAGES,
  slugProblem,
  suggestPublicSlug,
} from "@/lib/public-profile-meta";
import type { PublicSlugFormRaw } from "@/server/properties/public-profile-schema";

import type { PublicSlugFormState } from "./actions";

type Props = {
  action: (state: PublicSlugFormState, data: FormData) => Promise<PublicSlugFormState>;
  initial: PublicSlugFormRaw;
  /** Kayıtlı adres (yayındaki adres değişirken onay için). */
  savedSlug: string | null;
  isPublic: boolean;
  propertyName: string;
  district: string;
  /** Adres önizlemesi için alan adı: "kiraligim.com". */
  publicHost: string;
};

/**
 * Sayfa adresi (owner/manager). Öneri ve biçim uyarısı yalnız kolaylıktır; asıl doğrulama
 * sunucuda ve veritabanındadır (benzersizlik dahil). Yayındaki sayfanın adresi değişirken eski
 * bağlantının çalışmayacağı onaylatılır.
 */
export function SlugForm({
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
  const trimmed = slug.trim().toLowerCase();
  const localProblem = trimmed === "" ? null : slugProblem(trimmed);
  const slugChanging = isPublic && savedSlug !== null && trimmed !== savedSlug;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
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
      <div className="flex justify-end">
        <Button type="submit" disabled={!hydrated || pending}>
          {pending ? "Kaydediliyor…" : "Adresi kaydet"}
        </Button>
      </div>
    </form>
  );
}
