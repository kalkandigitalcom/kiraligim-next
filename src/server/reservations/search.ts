import { z } from "zod";

import { RESERVATION_KINDS } from "@/lib/reservation-meta";

import { RESERVATION_VIEWS } from "./service";

/**
 * Misafir adı araması (liste sayfası). Arama terimi URL'ye, sorgu dizesine veya tarayıcı
 * geçmişine yazılmaz: istemci yerel state'te tutar ve bu girdiyi server action ile (POST
 * gövdesinde) gönderir. Burada yalnız şekil ve sınırlar doğrulanır; erişim kuralları
 * (işletme, RLS) listReservations'tadır.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SEARCH_PAGE_SIZE = 20;
export const SEARCH_MAX_PAGE = 500;

export const reservationSearchInput = z.strictObject({
  view: z.enum(RESERVATION_VIEWS),
  kind: z.enum(RESERVATION_KINDS).optional(),
  propertyId: z.string().regex(UUID).optional(),
  query: z.string().trim().min(1).max(120),
  page: z.number().int().min(1).max(SEARCH_MAX_PAGE),
});

export type ReservationSearchInput = z.infer<typeof reservationSearchInput>;
