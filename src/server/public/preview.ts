import "server-only";

import { sql } from "drizzle-orm";

import type { TenantContext, Tx } from "@/db/tenant";
import { pageVisibility, type PageVisibility } from "@/lib/public-profile-meta";
import { busyQueryWindow, type PublicVilla } from "@/lib/public-villa";
import { istanbulToday } from "@/lib/reservation-meta";
import { getEntitlements } from "@/server/billing/entitlements";
import { canManageProperties, isUuid } from "@/server/properties/service";
import type { ObjectStorage } from "@/server/storage";

import {
  type BusyRow,
  buildPublicVilla,
  type PhotoRow,
  type RateRow,
  type VillaRow,
} from "./villa";

/**
 * Panel önizlemesi (F2d): villanın müşteriye açık sayfasının, yayında olmasa da, ev sahibine
 * gösterilecek hâli. YALNIZ panel tenant bağlamında (withPanelTenant → withTenant) çalışır:
 *  - Yetki sunucuda: yalnız owner/manager (canManageProperties); staff "forbidden" alır.
 *  - Veri RLS ile yalnız kullanıcının aktif işletmesinden okunur; başka işletmenin mülk kimliği
 *    "bulunamadı" ile aynıdır (varlık sızmaz). URL'de gizli bilgi/token yoktur; erişim oturum +
 *    üyelik + rol ile belirlenir.
 *  - Okuma public sayfayla AYNI kolon listesi ve AYNI eşlemeyle (buildPublicVilla) yapılır; tam
 *    adres, koordinat, belge no, işletme adı, misafir/rezervasyon ayrıntısı seçilmez.
 *  - Transaction salt okunura çevrilir: önizleme hiçbir şey yazamaz.
 */

export type VillaPreview =
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | {
      kind: "ok";
      villa: PublicVilla;
      /** Kayıtlı sayfa adresi (yoksa null: yayın için önce adres gerekir). */
      publicSlug: string | null;
      /** Yayın durumu ve eksik koşullar (panelle aynı kural). */
      visibility: PageVisibility;
      /** İşletmede WhatsApp numarası tanımlı mı (önizlemede bağlantılar buna göre). */
      hasWhatsapp: boolean;
    };

type PreviewRow = Omit<VillaRow, "contact_whatsapp"> & {
  contact_whatsapp: string | null;
  public_slug: string | null;
  is_public: boolean;
  status: "active" | "passive";
  photo_count: number;
};

export async function getVillaPreview(
  tx: Tx,
  ctx: TenantContext,
  propertyId: string,
  storage: ObjectStorage | null,
  today: string = istanbulToday(),
): Promise<VillaPreview> {
  if (!canManageProperties(ctx.role)) return { kind: "forbidden" };
  if (!isUuid(propertyId)) return { kind: "not_found" };
  // Savunma: bu transaction'da yazma olamaz (önizleme yalnız okur).
  await tx.execute(sql`set transaction read only`);

  const row = (
    await tx.execute<PreviewRow>(sql`
      select p.id as property_id, p.name, p.property_type,
             p.description, p.description_html, p.youtube_video_ids,
             p.max_guests, p.bedrooms, p.bathrooms,
             p.province, p.district, p.neighborhood,
             p.map_mode, p.map_embed_url, p.map_pin_lat::text, p.map_pin_lng::text,
             p.distance_market_km::text, p.distance_restaurant_km::text,
             p.distance_center_km::text, p.distance_beach_km::text,
             p.distance_airport_ayt_km::text, p.distance_airport_dlm_km::text,
             p.distance_health_km::text,
             p.distance_market_unit, p.distance_restaurant_unit, p.distance_center_unit,
             p.distance_beach_unit, p.distance_airport_ayt_unit, p.distance_airport_dlm_unit,
             p.distance_health_unit,
             p.pool_swimming, p.pool_swimming_depth::text, p.pool_swimming_width::text,
             p.pool_swimming_length::text, p.pool_swimming_protected,
             p.pool_indoor, p.pool_indoor_depth::text, p.pool_indoor_width::text,
             p.pool_indoor_length::text,
             p.pool_kids, p.pool_kids_depth::text, p.pool_kids_width::text,
             p.pool_kids_length::text,
             p.amenities, to_char(p.check_in_time, 'HH24:MI') as check_in_time,
             to_char(p.check_out_time, 'HH24:MI') as check_out_time,
             p.house_rules, p.house_rule_keys, p.price_includes,
             w.contact_whatsapp, p.updated_at,
             p.public_slug, p.is_public, p.status,
             (select count(*)::int from property_photos f where f.property_id = p.id) as photo_count
        from properties p
        join workspaces w on w.id = p.workspace_id
       where p.id = ${propertyId} and p.workspace_id = app_current_workspace_id()`)
  ).rows[0];
  if (!row) return { kind: "not_found" };

  const photos = (
    await tx.execute<PhotoRow>(sql`
      select storage_prefix, width, height, is_cover
        from property_photos
       where property_id = ${propertyId}
       order by is_cover desc, sort_order, id
       limit 80`)
  ).rows;
  // Public fonksiyonla aynı ufuk: bitişi bugünden sonra, başlangıcı 18 ay + 61 günden önce.
  const rates = (
    await tx.execute<RateRow>(sql`
      select to_char(start_date, 'YYYY-MM-DD') as start_date,
             to_char(end_date, 'YYYY-MM-DD') as end_date,
             nightly_amount_minor, weekly_amount_minor, currency::text as currency, min_nights,
             cleaning_fee_minor, cleaning_fee_free_nights
        from property_rates
       where property_id = ${propertyId}
         and end_date > ${today}::date
         and start_date < (${today}::date + interval '18 months')::date + 61
       order by start_date`)
  ).rows;
  // Dolu geceler: beklemede + onaylı + bloklar ve etkin harici takvim (iCal) dolulukları
  // ayrımsız, birleşik ve pencereye kırpılmış (app_public_villa_busy ile aynı kural, 0029).
  // Ad, durum, tür, not, tutar okunmaz.
  const w = busyQueryWindow(today);
  const busy = (
    await tx.execute<BusyRow>(sql`
      with win as (
        select greatest(${w.from}::date, ${today}::date - 1) as f,
               least(${w.to}::date, (${today}::date + interval '18 months')::date + 61) as t
      ), spans as (
        select daterange(r.check_in, r.check_out, '[)') as d
          from reservations r, win
         where r.property_id = ${propertyId}
           and r.status in ('pending', 'confirmed')
           and r.check_in < win.t and r.check_out > win.f
           and win.f < win.t
        union all
        select daterange(e.start_date, e.end_date, '[)')
          from external_calendar_events e
          join external_calendar_sources s on s.id = e.source_id and s.workspace_id = e.workspace_id,
               win
         where e.property_id = ${propertyId}
           and e.is_active and s.is_active
           and e.start_date < win.t and e.end_date > win.f
           and win.f < win.t
      ), merged as (
        select unnest(range_agg(sp.d * daterange(win.f, win.t, '[)'))) as b
          from spans sp, win
      )
      select to_char(lower(b), 'YYYY-MM-DD') as start_date, to_char(upper(b), 'YYYY-MM-DD') as end_date
        from merged where not isempty(b) order by lower(b)`)
  ).rows;

  // Panelle aynı kural (F1 getPublicProfile): abonelik durumu entitlements'tan.
  const visibility = pageVisibility({
    isPublic: row.is_public,
    propertyActive: row.status === "active",
    slug: row.public_slug,
    photoCount: row.photo_count,
    hasWhatsapp: !!row.contact_whatsapp,
    subscriptionCurrent: (await getEntitlements(tx))?.isCurrent ?? false,
  });
  const villa = buildPublicVilla(
    row.public_slug ?? "",
    { villa: { ...row, contact_whatsapp: row.contact_whatsapp ?? "" }, photos, rates, busy },
    storage,
    today,
  );
  return {
    kind: "ok",
    villa,
    publicSlug: row.public_slug,
    visibility,
    hasWhatsapp: !!row.contact_whatsapp,
  };
}
