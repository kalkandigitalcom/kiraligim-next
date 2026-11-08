import "server-only";

import { sql } from "drizzle-orm";

import { type PublicDb, withPublicRead } from "@/db/public";
import type { Tx } from "@/db/tenant";
import { safeMapEmbedUrl } from "@/lib/map-embed";
import { slugProblem } from "@/lib/public-profile-meta";
import {
  busyQueryWindow,
  lastCheckInDay,
  PUBLIC_BOOKING,
  type PublicPhoto,
  type PublicPool,
  type PublicVilla,
} from "@/lib/public-villa";
import { normalizeBusy } from "@/lib/availability";
import type { RatePeriod } from "@/lib/rate-meta";
import { CURRENCIES, type Currency, istanbulToday } from "@/lib/reservation-meta";
import { plainTextToHtml } from "@/lib/rich-text";
import {
  DISTANCE_COLUMNS,
  DISTANCE_KEYS,
  orderHouseRules,
  orderPriceIncludes,
} from "@/lib/villa-extras";
import { descriptionText, sanitizeDescription } from "@/server/properties/description";
import { photoSources } from "@/server/properties/photo-urls";
import type { ObjectStorage } from "@/server/storage";

/**
 * Müşteriye açık villa sayfası verisi (F2a). Oturum yoktur: veriye YALNIZ drizzle/0024'teki
 * app_public_villa* fonksiyonlarıyla, salt okunur public bağlamda (withPublicRead) erişilir.
 * Fonksiyonlar görünürlüğü (yayında + aktif + adres + fotoğraf + WhatsApp + abonelik) kendileri
 * denetler; burada yalnız istemciye gidecek alanlar seçilir (allowlist).
 */

export type VillaRow = {
  property_id: string;
  name: string;
  property_type: string;
  description: string | null;
  description_html: string | null;
  youtube_video_ids: string[] | null;
  max_guests: number;
  bedrooms: number;
  bathrooms: number;
  province: string;
  district: string;
  neighborhood: string | null;
  map_embed_url: string | null;
  distance_market_km: string | null;
  distance_restaurant_km: string | null;
  distance_center_km: string | null;
  distance_beach_km: string | null;
  distance_airport_ayt_km: string | null;
  distance_airport_dlm_km: string | null;
  distance_health_km: string | null;
  pool_swimming: boolean;
  pool_swimming_depth: string | null;
  pool_swimming_width: string | null;
  pool_swimming_length: string | null;
  pool_swimming_protected: boolean;
  pool_indoor: boolean;
  pool_indoor_depth: string | null;
  pool_indoor_width: string | null;
  pool_indoor_length: string | null;
  pool_kids: boolean;
  pool_kids_depth: string | null;
  pool_kids_width: string | null;
  pool_kids_length: string | null;
  amenities: string[] | null;
  check_in_time: string | null;
  check_out_time: string | null;
  house_rules: string | null;
  house_rule_keys: string[] | null;
  price_includes: string[] | null;
  cancellation_policy: string | null;
  payment_terms: string | null;
  contact_whatsapp: string;
  updated_at: Date | string;
};

export type PhotoRow = { storage_prefix: string; width: number; height: number; is_cover: boolean };

export type RateRow = {
  start_date: string;
  end_date: string;
  nightly_amount_minor: string | number | null;
  weekly_amount_minor: string | number | null;
  currency: string;
  min_nights: number | null;
  cleaning_fee_minor: string | number | null;
  cleaning_fee_free_nights: number | null;
};

export type BusyRow = { start_date: string; end_date: string };

const money = (v: string | number | null) => (v === null ? null : Number(v));

function pool(
  present: boolean,
  depth: string | null,
  width: string | null,
  length: string | null,
  isProtected?: boolean,
): PublicPool | null {
  if (!present || depth === null || width === null || length === null) return null;
  return {
    depth: Number(depth),
    width: Number(width),
    length: Number(length),
    ...(isProtected === undefined ? {} : { protected: isProtected }),
  };
}

/** Açıklama: kayıtlı temiz HTML okunurken yeniden temizlenir; eski düz metin kayıtlar HTML'e çevrilir. */
function description(r: VillaRow): { html: string | null; text: string | null } {
  const source = r.description_html ?? (r.description ? plainTextToHtml(r.description) : null);
  if (!source) return { html: null, text: null };
  const clean = sanitizeDescription(source);
  return clean
    ? { html: clean.html, text: descriptionText(clean.html) }
    : { html: null, text: null };
}

/** Girilmiş mesafeler (katalog sırasıyla); boş olanlar listede yer almaz. */
function rowDistances(r: VillaRow): PublicVilla["distances"] {
  const out: PublicVilla["distances"] = [];
  for (const key of DISTANCE_KEYS) {
    const v = r[DISTANCE_COLUMNS[key] as keyof VillaRow] as string | null;
    const km = v === null ? null : Number(v);
    if (km !== null && Number.isFinite(km) && km > 0) out.push({ key, km });
  }
  return out;
}

export const toRatePeriods = (rows: RateRow[]): RatePeriod[] =>
  rows
    .filter((r): r is RateRow & { currency: Currency } =>
      (CURRENCIES as readonly string[]).includes(r.currency),
    )
    .map((r, i) => ({
      id: `d${i + 1}`,
      startDate: r.start_date,
      endDate: r.end_date,
      nightlyAmountMinor: money(r.nightly_amount_minor),
      weeklyAmountMinor: money(r.weekly_amount_minor),
      currency: r.currency,
      minNights: r.min_nights,
      cleaningFeeMinor: money(r.cleaning_fee_minor),
      cleaningFeeFreeNights: r.cleaning_fee_free_nights,
    }));

export function toPublicPhotos(rows: PhotoRow[], storage: ObjectStorage | null): PublicPhoto[] {
  const out: PublicPhoto[] = [];
  for (const r of rows) {
    const s = photoSources(storage, r.storage_prefix);
    if (!s) continue;
    out.push({ ...s, width: r.width, height: r.height, isCover: r.is_cover });
  }
  return out;
}

/** Dört okuma; hepsi aynı salt okunur transaction'da (tutarlı görüntü). */
async function load(tx: Tx, slug: string, today: string) {
  const villa = (await tx.execute<VillaRow>(sql`select * from app_public_villa(${slug})`)).rows[0];
  if (!villa) return null;
  const id = villa.property_id;
  const w = busyQueryWindow(today);
  const photos = (await tx.execute<PhotoRow>(sql`select * from app_public_villa_photos(${id})`))
    .rows;
  const rates = (await tx.execute<RateRow>(sql`select * from app_public_villa_rates(${id})`)).rows;
  const busy = (
    await tx.execute<BusyRow>(
      sql`select * from app_public_villa_busy(${id}, ${w.from}::date, ${w.to}::date)`,
    )
  ).rows;
  return { villa, photos, rates, busy };
}

/**
 * Yayındaki villanın sayfa verisi; yoksa (taslak, pasif, abonelik bitmiş, başka koşul eksik,
 * geçersiz adres) null → sayfa 404. Sonuç yalnız public alanları içerir.
 */
export async function getPublicVilla(
  db: PublicDb,
  storage: ObjectStorage | null,
  rawSlug: string,
  today: string = istanbulToday(),
): Promise<PublicVilla | null> {
  const slug = typeof rawSlug === "string" ? rawSlug.trim().toLowerCase() : "";
  if (slugProblem(slug) === "format" || slugProblem(slug) === "double_dash") return null;
  const data = await withPublicRead(db, (tx) => load(tx, slug, today));
  if (!data) return null;
  return buildPublicVilla(slug, data, storage, today);
}

/**
 * Satırlardan sayfa nesnesi (allowlist). Public okuma ve panel önizlemesi (F2d) AYNI eşlemeyi
 * kullanır; böylece önizleme, yayındaki sayfayla birebir aynı alanları gösterir.
 */
export function buildPublicVilla(
  slug: string,
  data: { villa: VillaRow; photos: PhotoRow[]; rates: RateRow[]; busy: BusyRow[] },
  storage: ObjectStorage | null,
  today: string,
): PublicVilla {
  const { villa: r } = data;
  const desc = description(r);
  const rates = toRatePeriods(data.rates);
  return {
    slug,
    name: r.name,
    propertyType: r.property_type,
    descriptionHtml: desc.html,
    descriptionText: desc.text,
    // Tek video: kayıtta birden çok kimlik kalmış olsa da (eski kayıt) yalnız ilki gösterilir.
    youtubeVideoId: r.youtube_video_ids?.[0] ?? null,
    maxGuests: r.max_guests,
    bedrooms: r.bedrooms,
    bathrooms: r.bathrooms,
    location: { province: r.province, district: r.district, neighborhood: r.neighborhood },
    // Gösterimden önce yeniden doğrulanır: kalıba uymayan adres hiç gösterilmez.
    mapEmbedUrl: safeMapEmbedUrl(r.map_embed_url),
    distances: rowDistances(r),
    pools: {
      swimming: pool(
        r.pool_swimming,
        r.pool_swimming_depth,
        r.pool_swimming_width,
        r.pool_swimming_length,
        r.pool_swimming_protected,
      ),
      indoor: pool(r.pool_indoor, r.pool_indoor_depth, r.pool_indoor_width, r.pool_indoor_length),
      kids: pool(r.pool_kids, r.pool_kids_depth, r.pool_kids_width, r.pool_kids_length),
    },
    amenities: r.amenities ?? [],
    checkInTime: r.check_in_time,
    checkOutTime: r.check_out_time,
    houseRuleKeys: orderHouseRules(r.house_rule_keys ?? []).map((x) => x.key),
    houseRules: r.house_rules,
    priceIncludes: orderPriceIncludes(r.price_includes ?? []).map((x) => x.key),
    cancellationPolicy: r.cancellation_policy,
    paymentTerms: r.payment_terms,
    whatsapp: r.contact_whatsapp,
    photos: toPublicPhotos(data.photos, storage),
    rates,
    currency: rates[0]?.currency ?? null,
    busy: normalizeBusy(data.busy.map((b) => ({ start: b.start_date, end: b.end_date }))),
    window: { today, lastCheckIn: lastCheckInDay(today), maxNights: PUBLIC_BOOKING.maxNights },
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/** Sayfa nesnesinin üst düzey anahtarları (testler sızıntıya karşı bu listeyi kilitler). */
export const PUBLIC_VILLA_KEYS = [
  "slug",
  "name",
  "propertyType",
  "descriptionHtml",
  "descriptionText",
  "youtubeVideoId",
  "maxGuests",
  "bedrooms",
  "bathrooms",
  "location",
  "mapEmbedUrl",
  "distances",
  "pools",
  "amenities",
  "checkInTime",
  "checkOutTime",
  "houseRuleKeys",
  "houseRules",
  "priceIncludes",
  "cancellationPolicy",
  "paymentTerms",
  "whatsapp",
  "photos",
  "rates",
  "currency",
  "busy",
  "window",
  "updatedAt",
] as const;
