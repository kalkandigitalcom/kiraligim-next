"use client";

import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { SLUG_MAX, slugify } from "@/lib/slug";

import { createWorkspaceAction, type CreateWorkspaceState } from "./actions";

export function CreateWorkspaceForm() {
  const [state, action, pending] = useActionState<CreateWorkspaceState, FormData>(
    createWorkspaceAction,
    {},
  );
  const [name, setName] = useState(state.values?.name ?? "");
  const [slug, setSlug] = useState(state.values?.slug ?? "");
  // Kullanıcı kısa adı elle değiştirene kadar addan önerilir.
  const [slugTouched, setSlugTouched] = useState(false);

  return (
    <form action={action} noValidate className="flex flex-col gap-5">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <Field
        id="name"
        name="name"
        label="İşletme adı"
        placeholder="Örn. Kalkan Deniz Villaları"
        autoComplete="organization"
        maxLength={120}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          if (!slugTouched) setSlug(slugify(e.target.value));
        }}
        error={state.fieldErrors?.name}
        required
      />
      <Field
        id="slug"
        name="slug"
        label="Kısa adres"
        placeholder="kalkan-deniz-villalari"
        maxLength={SLUG_MAX}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={slug}
        onChange={(e) => {
          setSlugTouched(true);
          setSlug(e.target.value.toLowerCase());
        }}
        hint="3–48 karakter; küçük harf, rakam ve tire. İşletmenizi bağlantılarda tanımlar."
        error={state.fieldErrors?.slug}
        required
      />
      <div className="rounded-lg bg-mist px-4 py-3 text-sm text-muted-foreground">
        İşletmeyi oluşturduğunuzda <strong className="text-navy-900">sahip (owner)</strong> rolüyle
        eklenirsiniz. Ekip üyelerini daha sonra davet edebilirsiniz.
      </div>
      <Button type="submit" className="w-full sm:w-auto sm:self-end" disabled={pending}>
        {pending ? "Oluşturuluyor…" : "İşletmeyi oluştur"}
      </Button>
    </form>
  );
}
