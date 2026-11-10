"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, SelectField, TextareaField } from "@/components/ui/field";
import { useHydrated } from "@/components/ui/use-hydrated";

import { approveProposalAction, type DecisionState, rejectProposalAction } from "./actions";

type Option = { value: string; label: string };

export type ApproveDefaults = {
  propertyId: string;
  checkIn: string;
  checkOut: string;
  adults: number | null;
  children: number;
  status: "confirmed" | "pending";
};

const first = (errs: Record<string, string[] | undefined> | undefined, k: string) => errs?.[k]?.[0];

/**
 * Onay formu: öneriden ön doldurulur, yönetici her alanı düzeltebilir. Gönderim sunucuda
 * yeniden doğrulanır (yetki, sürüm, çakışma, kapasite); hata olursa hiçbir şey yazılmaz.
 */
export function ApproveForm({
  id,
  version,
  action,
  defaults,
  properties,
}: {
  id: string;
  version: number;
  action: "reserve" | "close";
  defaults: ApproveDefaults;
  properties: Option[];
}) {
  const hydrated = useHydrated();
  const [state, formAction, pending] = useActionState<DecisionState, FormData>(
    approveProposalAction.bind(null, id),
    {},
  );
  const fe = state.fieldErrors;
  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="wa-proposal-approve">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <input type="hidden" name="version" value={version} />
      <SelectField
        id="wa-p-property"
        name="propertyId"
        label="Villa"
        defaultValue={defaults.propertyId}
        placeholder="Villa seçin"
        options={properties}
        error={first(fe, "propertyId")}
        required
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="wa-p-in"
          name="checkIn"
          type="date"
          label="Giriş"
          defaultValue={defaults.checkIn}
          error={first(fe, "checkIn")}
          required
        />
        <Field
          id="wa-p-out"
          name="checkOut"
          type="date"
          label="Çıkış"
          defaultValue={defaults.checkOut}
          error={first(fe, "checkOut")}
          required
        />
      </div>
      {action === "reserve" ? (
        <>
          <Field
            id="wa-p-guest"
            name="guestName"
            label="Misafir adı"
            autoComplete="off"
            hint="Mesajda misafir adı yoksa buraya yazın."
            error={first(fe, "guestName")}
            required
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              id="wa-p-adults"
              name="adults"
              type="number"
              min={1}
              label="Yetişkin"
              defaultValue={defaults.adults ?? ""}
              error={first(fe, "adults")}
              required
            />
            <Field
              id="wa-p-children"
              name="children"
              type="number"
              min={0}
              label="Çocuk"
              defaultValue={defaults.children}
              error={first(fe, "children")}
            />
            <SelectField
              id="wa-p-status"
              name="status"
              label="Durum"
              defaultValue={defaults.status}
              options={[
                { value: "confirmed", label: "Onaylı" },
                { value: "pending", label: "Beklemede" },
              ]}
              error={first(fe, "status")}
            />
          </div>
        </>
      ) : null}
      <TextareaField
        id="wa-p-note"
        name="note"
        label="Not (isteğe bağlı)"
        rows={2}
        maxLength={500}
        error={first(fe, "note")}
      />
      <div>
        <Button type="submit" disabled={pending || !hydrated} data-testid="wa-proposal-approve-btn">
          {pending
            ? "Kaydediliyor…"
            : action === "reserve"
              ? "Onayla ve rezervasyonu oluştur"
              : "Onayla ve tarihleri kapat"}
        </Button>
      </div>
    </form>
  );
}

/** Ret formu: takvim değişmez; öneri "reddedildi" olur. */
export function RejectForm({ id, version }: { id: string; version: number }) {
  const hydrated = useHydrated();
  const [state, formAction, pending] = useActionState<DecisionState, FormData>(
    rejectProposalAction.bind(null, id),
    {},
  );
  return (
    <form action={formAction} className="flex flex-col gap-3" data-testid="wa-proposal-reject">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <input type="hidden" name="version" value={version} />
      <TextareaField
        id="wa-p-reject-note"
        name="note"
        label="Ret notu (isteğe bağlı)"
        rows={2}
        maxLength={500}
      />
      <div>
        <Button
          type="submit"
          variant="secondary"
          disabled={pending || !hydrated}
          data-testid="wa-proposal-reject-btn"
        >
          {pending ? "Kaydediliyor…" : "Reddet"}
        </Button>
      </div>
    </form>
  );
}
