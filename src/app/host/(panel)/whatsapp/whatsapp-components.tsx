"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { SelectField } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";

import {
  claimGroupAction,
  type ClaimFormState,
  createPhoneChallengeAction,
  type PhoneChallengeFormState,
  type PhoneChallengePoll,
  pollPhoneChallengeAction,
  type SimpleState,
} from "./actions";

/* ── Numara doğrulama (asistana özel mesaj; bir kez) ────────────────────── */

function useCountdown(expiresAt: string | null) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () =>
      setLeft(Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  return left;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * Kullanıcının WhatsApp numarasını bir kez doğrular: kod asistana ÖZEL mesajla gönderilir (gruba
 * değil). Numara panelde yazılmaz; WhatsApp'ın bildirdiği gönderen numarası kullanılır.
 */
export function PhoneVerifyPanel() {
  const router = useRouter();
  const hydrated = useHydrated();
  const [state, formAction, pending] = useActionState<PhoneChallengeFormState, FormData>(
    createPhoneChallengeAction,
    {},
  );
  const issued = state.issued ?? null;
  const left = useCountdown(issued?.expiresAt ?? null);
  const [poll, setPoll] = useState<{ id: string; result: PhoneChallengePoll } | null>(null);
  const [copied, setCopied] = useState(false);
  const result = issued && poll?.id === issued.id ? poll.result : null;

  useEffect(() => {
    if (!issued) return;
    let stop = false;
    const id = issued.id;
    const t = setInterval(async () => {
      const r = await pollPhoneChallengeAction(id);
      if (stop) return;
      setPoll({ id, result: r });
      if (r.state !== "pending") {
        clearInterval(t);
        if (r.state === "used") router.refresh();
      }
    }, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [issued, router]);

  if (!issued) {
    return (
      <form action={formAction} className="flex flex-col gap-3">
        {state.error ? <Alert tone="error">{state.error}</Alert> : null}
        <div>
          <Button type="submit" disabled={pending || !hydrated} data-testid="wa-verify-start">
            {pending ? "Hazırlanıyor…" : "Numaramı doğrula"}
          </Button>
        </div>
      </form>
    );
  }

  if (result?.state === "used") {
    return (
      <Alert tone="success">
        <span data-testid="wa-verify-success">
          Numaranız doğrulandı{result.masked ? ` (${result.masked})` : ""}. Asistanı eklediğiniz
          gruplar aşağıda görünür.
        </span>
      </Alert>
    );
  }

  if (result?.state === "expired" || left === 0) {
    return (
      <div className="flex flex-col gap-2">
        <Alert tone="error">Kodun süresi doldu. Yeniden deneyin.</Alert>
        <div>
          <Button type="button" variant="secondary" onClick={() => router.refresh()}>
            Yenile
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="wa-verify-panel">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-navy-900">
        <li>
          {issued.link
            ? "Aşağıdaki düğmeyle WhatsApp'ı açın; mesaj hazır gelir, yalnız gönderin."
            : "Kiraligim asistan numarasına WhatsApp'tan özel mesaj olarak aşağıdaki metni gönderin."}
        </li>
        <li>Mesajı, gruplara asistanı eklediğiniz kendi numaranızdan gönderin.</li>
        <li>Mesaj gruba DEĞİL, asistana özel olarak gönderilir.</li>
      </ol>
      <p
        className="rounded-lg border border-border bg-white px-3 py-2.5 font-mono text-base tracking-wide break-all text-navy-900"
        data-testid="wa-verify-message"
      >
        {issued.message}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {issued.link ? (
          <a
            href={issued.link}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ size: "sm" })}
            data-testid="wa-verify-link"
          >
            WhatsApp&apos;ta aç
          </a>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            navigator.clipboard
              ?.writeText(issued.message)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
          data-testid="wa-verify-copy"
        >
          Metni kopyala
        </Button>
        <span className="text-sm text-muted-foreground" role="status">
          {copied ? "Kopyalandı. " : ""}
          {left != null ? `Kalan süre ${mmss(left)} · mesaj bekleniyor…` : ""}
        </span>
      </div>
    </div>
  );
}

/* ── Grup eşleştirme (villa seçimi) ─────────────────────────────────────── */

type PropertyOption = { value: string; label: string };

/** Bekleyen grubu bir villayla eşleştirir; yalnız bu işletmenin villaları listelenir. */
export function ClaimGroupForm({
  groupId,
  groupName,
  properties,
}: {
  groupId: string;
  groupName: string;
  properties: readonly PropertyOption[];
}) {
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<ClaimFormState, FormData>(
    claimGroupAction,
    {},
  );
  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Eşleştir: ${groupName}`}
        data-testid="wa-claim-open"
      >
        Eşleştir
      </Button>
    );
  }
  return (
    <form action={formAction} className="flex w-full flex-col gap-3" data-testid="wa-claim-form">
      <input type="hidden" name="groupId" value={groupId} />
      <SelectField
        id={`wa-claim-${groupId}`}
        name="propertyId"
        label="Villa"
        placeholder="Villa seçin"
        options={properties}
        defaultValue=""
        required
        error={state.propertyError}
        hint="Grubun mesajları bu villayla ilişkilendirilir. Yalnız hesabınızdaki villalar listelenir."
      />
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending || !hydrated} data-testid="wa-claim-save">
          {pending ? "Kaydediliyor…" : "Kaydet"}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
          Vazgeç
        </Button>
      </div>
    </form>
  );
}

/** Bağlı grubun villasını değiştirir. */
export function GroupPropertyForm({
  action,
  groupId,
  current,
  groupName,
  properties,
}: {
  action: (prev: ClaimFormState, formData: FormData) => Promise<ClaimFormState>;
  groupId: string;
  current: string | null;
  groupName: string;
  properties: readonly PropertyOption[];
}) {
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<ClaimFormState, FormData>(action, {});
  if (!open) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Villayı değiştir: ${groupName}`}
        data-testid="wa-property-open"
      >
        {current ? "Villayı değiştir" : "Villa seç"}
      </Button>
    );
  }
  return (
    <form action={formAction} className="flex w-full flex-col gap-3" data-testid="wa-property-form">
      <SelectField
        id={`wa-property-${groupId}`}
        name="propertyId"
        label="Villa"
        placeholder="Villa seçin"
        options={properties}
        defaultValue={current ?? ""}
        required
        error={state.propertyError}
      />
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={pending || !hydrated}
          data-testid="wa-property-save"
        >
          {pending ? "Kaydediliyor…" : "Kaydet"}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
          Vazgeç
        </Button>
      </div>
    </form>
  );
}

/* ── Grup ve yetki düğmeleri ─────────────────────────────────────────────── */

export function ActionButton({
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

export function UnlinkButton({
  name,
  action,
}: {
  name: string;
  action: () => Promise<SimpleState>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<SimpleState>(action, {});
  if (!confirming) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setConfirming(true)}
        aria-label={`Bağlantıyı kes: ${name}`}
        data-testid="wa-unlink"
      >
        Bağlantıyı kes
      </Button>
    );
  }
  return (
    <form action={formAction} className="flex w-full flex-wrap items-center gap-2" role="group">
      <span className="text-sm font-medium text-navy-900">
        Grubun bağlantısı kesilsin ve kayıtlı mesajları silinsin mi?
      </span>
      <Button
        type="submit"
        size="sm"
        disabled={pending}
        aria-label={`Evet, bağlantıyı kes: ${name}`}
        data-testid="wa-unlink-confirm"
      >
        {pending ? "Kesiliyor…" : "Evet, kes"}
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
