"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";
import { ICAL_LIMITS, ICAL_SOURCE_PRESETS } from "@/lib/ical-meta";

import type { SimpleState, SourceFormState } from "./actions";

/* ── Kaynak formu (ekle / düzenle) ───────────────────────────────────────── */

export function SourceForm({
  mode,
  action,
  initial,
  cancelHref,
}: {
  mode: "create" | "edit";
  action: (state: SourceFormState, data: FormData) => Promise<SourceFormState>;
  initial: { name: string; url: string; isActive: boolean };
  cancelHref?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const hydrated = useHydrated();
  const v = state.values ?? initial;
  const fe = state.fieldErrors ?? {};
  const prefix = mode === "edit" ? "duzenle" : "yeni";
  return (
    <form
      key={JSON.stringify(v)}
      action={formAction}
      noValidate
      className="flex flex-col gap-4"
      aria-label={mode === "edit" ? "Harici takvimi düzenle" : "Yeni harici takvim"}
      data-testid={`ical-source-form-${mode}`}
    >
      {state.error && Object.keys(fe).length === 0 ? (
        <Alert tone="error">{state.error}</Alert>
      ) : null}
      <Field
        id={`${prefix}-name`}
        name="name"
        label="Takvim adı"
        defaultValue={v.name}
        maxLength={ICAL_LIMITS.nameMax}
        list="ical-source-presets"
        placeholder="Örn. Airbnb"
        autoComplete="off"
        required
        error={fe.name}
        hint="Platformun adı; takvimde harici dolulukla birlikte görünür."
      />
      <datalist id="ical-source-presets">
        {ICAL_SOURCE_PRESETS.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <Field
        id={`${prefix}-url`}
        name="url"
        label="iCal adresi"
        type="url"
        inputMode="url"
        defaultValue={v.url}
        maxLength={ICAL_LIMITS.urlMax}
        placeholder="https://… .ics"
        autoComplete="off"
        spellCheck={false}
        required
        error={fe.url}
        hint="Platformun takvim dışa aktarma (iCal / .ics) bağlantısı. Bu adres gizlidir; yalnız işletme sahibi ve yöneticiler görür."
      />
      <label className="flex items-start gap-2 text-sm text-navy-900">
        <input
          type="checkbox"
          name="isActive"
          defaultChecked={v.isActive}
          className="mt-0.5 size-4 accent-navy-900"
        />
        <span>
          Etkin — tarihleri takvimde kapatır ve otomatik senkron edilir. Pasif takvimin tarihleri
          müsaitliği etkilemez.
        </span>
      </label>
      {fe.isActive ? <p className="text-sm text-destructive">{fe.isActive}</p> : null}
      <div className="flex flex-col-reverse gap-3 border-t border-border pt-4 sm:flex-row sm:justify-end">
        {cancelHref ? (
          <Link href={cancelHref} className={buttonVariants({ variant: "secondary" })}>
            Vazgeç
          </Link>
        ) : null}
        <Button type="submit" className="w-full sm:w-auto" disabled={pending || !hydrated}>
          {pending
            ? mode === "edit"
              ? "Kaydediliyor…"
              : "Ekleniyor ve senkron ediliyor…"
            : mode === "edit"
              ? "Değişiklikleri kaydet"
              : "Takvimi ekle"}
        </Button>
      </div>
    </form>
  );
}

/* ── Kaynak satırı düğmeleri ─────────────────────────────────────────────── */

function ActionButton({
  action,
  label,
  pendingLabel,
  ariaLabel,
  testId,
}: {
  action: () => Promise<SimpleState>;
  label: string;
  pendingLabel: string;
  ariaLabel: string;
  testId: string;
}) {
  const [state, formAction, pending] = useActionState<SimpleState>(action, {});
  const hydrated = useHydrated();
  return (
    <form action={formAction} className="contents">
      <Button
        type="submit"
        variant="secondary"
        size="sm"
        disabled={pending || !hydrated}
        aria-label={ariaLabel}
        data-testid={testId}
      >
        {pending ? pendingLabel : label}
      </Button>
      {state.error ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function SourceControls({
  name,
  isActive,
  editHref,
  syncAction,
  toggleAction,
  deleteAction,
}: {
  name: string;
  isActive: boolean;
  editHref: string;
  syncAction: () => Promise<SimpleState>;
  toggleAction: () => Promise<SimpleState>;
  deleteAction: () => Promise<SimpleState>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<SimpleState>(deleteAction, {});
  if (confirming) {
    return (
      <form action={formAction} className="flex flex-wrap items-center gap-2" role="group">
        <span className="text-sm font-medium text-navy-900">
          Takvim ve ondan gelen tüm doluluklar silinsin mi? (Diğer takvimler etkilenmez.)
        </span>
        <Button type="submit" size="sm" disabled={pending} aria-label={`Evet, sil: ${name}`}>
          {pending ? "Siliniyor…" : "Evet, sil"}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => setConfirming(false)}>
          Vazgeç
        </Button>
        {state.error ? (
          <p role="alert" className="w-full text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
      </form>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {isActive ? (
        <ActionButton
          action={syncAction}
          label="Şimdi senkron et"
          pendingLabel="Senkron ediliyor…"
          ariaLabel={`Şimdi senkron et: ${name}`}
          testId="ical-sync"
        />
      ) : null}
      <ActionButton
        action={toggleAction}
        label={isActive ? "Pasifleştir" : "Etkinleştir"}
        pendingLabel="Kaydediliyor…"
        ariaLabel={`${isActive ? "Pasifleştir" : "Etkinleştir"}: ${name}`}
        testId="ical-toggle"
      />
      <Link
        href={editHref}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
        aria-label={`Düzenle: ${name}`}
      >
        Düzenle
      </Link>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setConfirming(true)}
        aria-label={`Sil: ${name}`}
        data-testid="ical-delete"
      >
        Sil
      </Button>
    </div>
  );
}

/* ── Dışa aktarma bağlantısı ─────────────────────────────────────────────── */

export function ExportLink({
  url,
  rotateAction,
}: {
  url: string;
  rotateAction: () => Promise<SimpleState>;
}) {
  const hydrated = useHydrated();
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<SimpleState>(rotateAction, {});
  return (
    <div className="flex flex-col gap-3">
      <p
        className="rounded-lg border border-border bg-mist px-3 py-2.5 font-mono text-sm break-all text-navy-900"
        data-testid="ical-export-url"
      >
        {url}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!hydrated}
          onClick={() => {
            navigator.clipboard
              ?.writeText(url)
              .then(() => setCopied("ok"))
              .catch(() => setCopied("fail"));
          }}
          data-testid="ical-export-copy"
        >
          Bağlantıyı kopyala
        </Button>
        {!confirming ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setConfirming(true)}
            data-testid="ical-export-rotate"
          >
            Bağlantıyı yenile
          </Button>
        ) : null}
        <span className="text-sm text-turquoise-700" role="status">
          {copied === "ok"
            ? "Kopyalandı."
            : copied === "fail"
              ? "Kopyalanamadı; adresi elle seçin."
              : ""}
        </span>
      </div>
      {confirming ? (
        <form
          action={formAction}
          className="flex flex-col gap-3 rounded-xl border border-amber-500/50 bg-amber-50 p-3"
          role="group"
        >
          <p className="text-sm text-amber-900">
            Yeni bağlantı oluşturulunca <strong>bu adres hemen çalışmaz</strong>. Adresi eklediğiniz
            tüm platformlarda (Airbnb, Booking.com vb.) yeni bağlantıyı tekrar eklemeniz gerekir;
            aksi halde o platformlar Kiraligim takviminizi göremez.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={pending}
              data-testid="ical-export-rotate-confirm"
            >
              {pending ? "Yenileniyor…" : "Evet, yeni bağlantı oluştur"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setConfirming(false)}
            >
              Vazgeç
            </Button>
          </div>
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
