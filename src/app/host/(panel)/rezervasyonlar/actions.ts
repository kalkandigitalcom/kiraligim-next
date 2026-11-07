"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import type { Quote } from "@/lib/pricing";
import { type ActionResult, ok, toActionError } from "@/lib/result";
import { quoteForProperty } from "@/server/rates/service";
import { type ReservationField, reservationFormValues } from "@/server/reservations/schema";
import { reservationSearchInput, SEARCH_PAGE_SIZE } from "@/server/reservations/search";
import {
  cancelReservation,
  confirmReservation,
  conflictMessage,
  createReservation,
  findConflicts,
  listReservations,
  updateReservation,
} from "@/server/reservations/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { type ReservationCardData, toCardData } from "./_components/reservation-card";

/**
 * Rezervasyon server action'ları. Kullanıcı ve işletme yalnız oturumdan (withPanelTenant →
 * withTenant); formdan yalnız rezervasyon alanları ve hedef kimlikler alınır. Kimlikler yetki
 * vermez: RLS başka işletmenin kaydını göstermez; rol, çakışma, pasif mülk ve tarih aralığı
 * serviste ve veritabanında yeniden denetlenir.
 */
async function runAction<T>(name: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return ok(await fn());
  } catch (err) {
    unstable_rethrow(err);
    return toActionError(err, { action: name });
  }
}

export type ReservationFormState = {
  error?: string;
  fieldErrors?: Partial<Record<ReservationField, string>>;
  values?: Record<ReservationField, string>;
};

const firstErrors = (fe: Record<string, string[]> | undefined) => {
  const out: Partial<Record<ReservationField, string>> = {};
  for (const [k, v] of Object.entries(fe ?? {})) if (v[0]) out[k as ReservationField] = v[0];
  return out;
};

export async function createReservationAction(
  _prev: ReservationFormState,
  formData: FormData,
): Promise<ReservationFormState> {
  const values = reservationFormValues(formData);
  const result = await runAction("reservation.create", () =>
    withPanelTenant((tx, ctx) => createReservation(tx, ctx, values)),
  );
  if (!result.ok) {
    return {
      error: result.error.message,
      fieldErrors: firstErrors(result.error.fieldErrors),
      values,
    };
  }
  redirect(`/rezervasyonlar/${result.data}?durum=olusturuldu`);
}

export async function updateReservationAction(
  id: string,
  _prev: ReservationFormState,
  formData: FormData,
): Promise<ReservationFormState> {
  const values = reservationFormValues(formData);
  const result = await runAction("reservation.update", () =>
    withPanelTenant((tx, ctx) => updateReservation(tx, ctx, String(id), values)),
  );
  if (!result.ok) {
    return {
      error: result.error.message,
      fieldErrors: firstErrors(result.error.fieldErrors),
      values,
    };
  }
  redirect(
    `/rezervasyonlar/${id}?durum=${result.data.changed > 0 ? "guncellendi" : "degisiklik-yok"}`,
  );
}

export type StatusActionState = { error?: string };

export async function confirmReservationAction(
  id: string,
  _prev: StatusActionState,
  _formData: FormData,
): Promise<StatusActionState> {
  const result = await runAction("reservation.confirm", () =>
    withPanelTenant((tx, ctx) => confirmReservation(tx, ctx, String(id))),
  );
  if (!result.ok) return { error: result.error.message };
  redirect(`/rezervasyonlar/${id}?durum=onaylandi`);
}

export async function cancelReservationAction(
  id: string,
  _prev: StatusActionState,
  formData: FormData,
): Promise<StatusActionState> {
  const reason = formData.get("cancelReason");
  const result = await runAction("reservation.cancel", () =>
    withPanelTenant((tx, ctx) =>
      cancelReservation(tx, ctx, String(id), typeof reason === "string" ? reason : undefined),
    ),
  );
  if (!result.ok) return { error: result.error.message };
  redirect(`/rezervasyonlar/${id}?durum=iptal`);
}

export type AvailabilityResult = { available: boolean; message?: string };

/**
 * Müsaitlik ön denetimi (formda tarih seçilince). Yalnız okur; asıl engel kayıt sırasında
 * veritabanındaki çakışma kısıtıdır.
 */
export async function checkAvailabilityAction(
  propertyId: string,
  checkIn: string,
  checkOut: string,
  excludeId?: string,
): Promise<AvailabilityResult> {
  const valid = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!valid(checkIn) || !valid(checkOut) || checkOut <= checkIn) return { available: true };
  const result = await runAction("reservation.availability", () =>
    withPanelTenant((tx) =>
      findConflicts(
        tx,
        String(propertyId),
        checkIn,
        checkOut,
        typeof excludeId === "string" ? excludeId : undefined,
      ),
    ),
  );
  if (!result.ok) return { available: true };
  return result.data.length === 0
    ? { available: true }
    : { available: false, message: conflictMessage(result.data) };
}

export type QuoteResult = { quote: Quote | null };

/**
 * Konaklama fiyat hesabı (Aşama 3.2) — SALT OKUNUR. Formdaki "Önerilen tutar" paneli için;
 * hiçbir kaydı değiştirmez. Tutar forma yalnız kullanıcı "Bu tutarı kullan" dediğinde yazılır.
 */
export async function quoteStayAction(
  propertyId: string,
  checkIn: string,
  checkOut: string,
): Promise<QuoteResult> {
  const result = await runAction("reservation.quote", () =>
    withPanelTenant((tx) =>
      quoteForProperty(tx, String(propertyId), String(checkIn), String(checkOut)),
    ),
  );
  return { quote: result.ok ? result.data : null };
}

export type SearchResult =
  | { ok: true; items: ReservationCardData[]; hasMore: boolean; page: number }
  | { ok: false; error: string };

/**
 * Misafir adına arama. Terim POST gövdesiyle gelir; URL'ye, sorgu dizesine veya tarayıcı
 * geçmişine yazılmaz ve log'a yazılmaz. Sonuçlar oturumdaki işletmeyle sınırlıdır (RLS).
 */
export async function searchReservationsAction(input: unknown): Promise<SearchResult> {
  const parsed = reservationSearchInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Arama yapılamadı." };
  const s = parsed.data;
  const result = await runAction("reservation.search", () =>
    withPanelTenant((tx) =>
      listReservations(tx, {
        view: s.view,
        kind: s.kind,
        propertyId: s.propertyId,
        query: s.query,
        limit: SEARCH_PAGE_SIZE,
        offset: (s.page - 1) * SEARCH_PAGE_SIZE,
      }),
    ),
  );
  if (!result.ok) return { ok: false, error: result.error.message };
  return {
    ok: true,
    items: result.data.items.map(toCardData),
    hasMore: result.data.hasMore,
    page: s.page,
  };
}
