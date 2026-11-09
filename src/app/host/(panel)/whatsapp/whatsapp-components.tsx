"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";

import {
  createLinkCodeAction,
  type LinkCodeFormState,
  type LinkCodePoll,
  pollLinkCodeAction,
  type SimpleState,
} from "./actions";

/* ── Grup bağlama ────────────────────────────────────────────────────────── */

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

export function LinkGroupPanel() {
  const router = useRouter();
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<LinkCodeFormState, FormData>(
    createLinkCodeAction,
    {},
  );
  const issued = state.issued ?? null;
  const left = useCountdown(issued?.expiresAt ?? null);
  const [poll, setPoll] = useState<{ id: string; result: LinkCodePoll } | null>(null);
  const [copied, setCopied] = useState(false);
  // Önceki kodun yoklama sonucu yeni koda taşınmaz.
  const result = issued && poll?.id === issued.id ? poll.result : null;

  useEffect(() => {
    if (!issued) return;
    let stop = false;
    const id = issued.id;
    const t = setInterval(async () => {
      const r = await pollLinkCodeAction(id);
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

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)} data-testid="wa-link-open">
        Grup bağla
      </Button>
    );
  }

  return (
    <div
      className="flex flex-col gap-4 rounded-xl border border-border bg-mist/60 p-4"
      data-testid="wa-link-panel"
    >
      <ol className="list-decimal space-y-1 pl-5 text-sm text-navy-900">
        <li>Kiraligim asistan numarasını WhatsApp grubunuza ekleyin (grup yöneticisi ekler).</li>
        <li>Aşağıya grupta yazacağınız kendi WhatsApp numaranızı girin ve kod alın.</li>
        <li>
          Kodu <strong>bu numaradan</strong>, 10 dakika içinde gruba yazın. Başka numaradan yazılan
          kod kabul edilmez.
        </li>
      </ol>
      <p className="text-sm text-muted-foreground">
        Grup bağlandıktan sonra gruptaki metin mesajları Kiraligim&apos;de 90 gün saklanır. Gruptaki
        kişileri bu konuda bilgilendirin.
      </p>

      {!issued ? (
        <form action={formAction} className="flex flex-col gap-3" noValidate>
          <Field
            id="wa-phone"
            name="phone"
            label="WhatsApp numaranız"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+90 532 123 45 67"
            defaultValue={state.phone ?? ""}
            error={state.phoneError}
            hint="Kod yalnız bu numaradan gruba yazılırsa kabul edilir. Numara düz metin saklanmaz."
          />
          {state.error ? <Alert tone="error">{state.error}</Alert> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending || !hydrated} data-testid="wa-link-create">
              {pending ? "Kod hazırlanıyor…" : "Kod al"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Vazgeç
            </Button>
          </div>
        </form>
      ) : result?.state === "used" ? (
        <Alert tone="success">
          <span data-testid="wa-link-success">
            {result.groupSubject ? `"${result.groupSubject}" grubu` : "Grup"} bağlandı. Gruptaki kod
            mesajında ✅ görünür.
          </span>
        </Alert>
      ) : result?.state === "expired" || left === 0 ? (
        <div className="flex flex-col gap-2">
          <Alert tone="error">Kodun süresi doldu. Yeni kod alın.</Alert>
          <Button type="button" variant="secondary" onClick={() => router.refresh()}>
            Yenile
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-navy-900">Gruba tam olarak şunu yazın:</p>
          <p
            className="rounded-lg border border-border bg-white px-3 py-2.5 font-mono text-lg tracking-wide break-all text-navy-900"
            data-testid="wa-link-message"
          >
            {issued.message}
          </p>
          <div className="flex flex-wrap items-center gap-2">
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
              data-testid="wa-link-copy"
            >
              Kopyala
            </Button>
            <span className="text-sm text-muted-foreground" role="status">
              {copied ? "Kopyalandı. " : ""}
              {left != null ? `Kalan süre ${mmss(left)} · bağlantı bekleniyor…` : ""}
            </span>
          </div>
        </div>
      )}
    </div>
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
