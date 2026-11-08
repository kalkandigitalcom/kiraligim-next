import { z } from "zod";

import {
  LICENSE_PATTERN,
  PROPERTY_LIMITS as L,
  POOL_KINDS,
  type PoolKind,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
} from "@/lib/property-meta";
import { MAP_INPUT_MAX, MAP_PARSE_MESSAGES, parseMapInput } from "@/lib/map-embed";
import {
  isMapMode,
  type MapMode,
  type MapPin,
  PIN_PARSE_MESSAGES,
  parsePinInput,
} from "@/lib/map-pin";
import { TR_PROVINCES } from "@/lib/tr-provinces";
import {
  DISTANCE_KEYS,
  DISTANCE_LABELS,
  DISTANCE_PARSE_MESSAGES,
  DISTANCE_UNIT_FIELDS,
  DISTANCE_UNIT_KEYS,
  type DistanceKey,
  type DistanceUnit,
  isDistanceUnit,
  parseDistanceInput,
} from "@/lib/villa-extras";
import { parseYouTubeId } from "@/lib/youtube";

import { type CleanDescription, sanitizeDescription } from "./description";

/**
 * Mülk formu doğrulaması. Kurallar veritabanı CHECK'leriyle aynıdır (src/db/schema/properties.ts);
 * veritabanı son savunma hattıdır. Form değerleri metin gelir: boş metin "yok" sayılır.
 */

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const text = (min: number, max: number, label: string) =>
  z
    .string({ error: `${label} gerekli.` })
    .trim()
    .min(1, { error: `${label} gerekli.`, abort: true })
    .min(min, `${label} en az ${min} karakter olmalı.`)
    .max(max, `${label} en fazla ${max} karakter olabilir.`);

const optionalText = (max: number, label: string) =>
  z.preprocess(
    blankToUndefined,
    z.string().trim().max(max, `${label} en fazla ${max} karakter olabilir.`).optional(),
  );

/** Boş → "gerekli", sayı olmayan → "bir sayı olmalı" (NaN da reddedilir). */
const int = (min: number, max: number, label: string) =>
  z.preprocess(
    (v) => {
      if (typeof v !== "string") return v;
      const t = v.trim();
      return t === "" ? undefined : Number(t);
    },
    z
      .number({
        error: (iss) =>
          iss.input === undefined ? `${label} gerekli.` : `${label} bir sayı olmalı.`,
      })
      .int(`${label} tam sayı olmalı.`)
      .min(min, `${label} en az ${min} olmalı.`)
      .max(max, `${label} en fazla ${max} olabilir.`),
  );

type Issue = { path: string[]; message: string };

/**
 * Mesafeler (Revizyon 2): her alanın kendi birimi (km / m). Değer ve birim birlikte denetlenir;
 * kayda km yazılır (numeric(8,3)), birim ayrı kolonda. Boş değer → mesafe ve birim yok (NULL).
 */
export type DistancesInput = {
  km: Record<DistanceKey, number | null>;
  unit: Record<DistanceKey, DistanceUnit | null>;
};

function distanceUnitOf(raw: Record<string, unknown>, k: DistanceKey): DistanceUnit | undefined {
  const u = raw[DISTANCE_UNIT_KEYS[k]];
  if (u === undefined || u === null || u === "") return "km";
  return isDistanceUnit(u) ? u : undefined;
}

function distanceIssues(raw: Record<string, unknown>): Issue[] {
  const out: Issue[] = [];
  for (const k of DISTANCE_KEYS) {
    const label = DISTANCE_LABELS[k];
    const unit = distanceUnitOf(raw, k);
    if (!unit) {
      out.push({ path: [DISTANCE_UNIT_KEYS[k]], message: `${label}: birim km veya m olmalı.` });
      continue;
    }
    const r = parseDistanceInput(raw[k], unit);
    if (!r.ok)
      out.push({ path: [k], message: `${label}: ${DISTANCE_PARSE_MESSAGES[unit][r.error]}` });
  }
  return out;
}

/** Ham mesafe alanları → km + birim (yalnız hatasız girdide çağrılır). */
export function distancesFromRaw(raw: Record<string, unknown>): DistancesInput {
  const out: DistancesInput = {
    km: {} as DistancesInput["km"],
    unit: {} as DistancesInput["unit"],
  };
  for (const k of DISTANCE_KEYS) {
    const unit = distanceUnitOf(raw, k) ?? "km";
    const r = parseDistanceInput(raw[k], unit);
    const km = r.ok ? r.km : null;
    out.km[k] = km;
    out.unit[k] = km === null ? null : unit;
  }
  return out;
}

/**
 * Harita (Revizyon 2): iki yöntem.
 *   google: "Haritayı yerleştir" kodu veya tam paylaşım bağlantısı → yalnız güvenli gömme adresi
 *           (src/lib/map-embed.ts; kurallar değişmedi). Boş → yok.
 *   pin:    enlem/boylam (Leaflet haritasında iğne). Boş → yok.
 * Seçili yöntemin girdisi hatalıysa hata gösterilir; seçili OLMAYAN yöntemin hatalı girdisi
 * (gizli sekmede kalmış) hata vermez ve saklanmaz. Seçilen yöntem her zaman açıkça kaydedilir;
 * verisi yoksa misafire harita gösterilmez. Diğer yöntemin geçerli verisi korunur (geri dönülebilir).
 */
export type MapInput = { mode: MapMode | null; embedUrl: string | null; pin: MapPin | null };

function chosenMapMode(raw: Record<string, unknown>): MapMode | undefined {
  const m = raw.mapMode;
  if (m === undefined || m === null || m === "") return "google";
  return isMapMode(m) ? m : undefined;
}

function googleOf(raw: Record<string, unknown>): { url: string | null; error?: string } {
  const t = typeof raw.mapLocation === "string" ? raw.mapLocation.trim() : "";
  if (!t) return { url: null };
  if (t.length > MAP_INPUT_MAX) return { url: null, error: "Harita kodu çok uzun." };
  const r = parseMapInput(t);
  return r.ok ? { url: r.url } : { url: null, error: MAP_PARSE_MESSAGES[r.error] };
}

function mapIssues(raw: Record<string, unknown>): Issue[] {
  const mode = chosenMapMode(raw);
  if (!mode) return [{ path: ["mapMode"], message: "Harita yöntemini seçin." }];
  if (mode === "google") {
    const g = googleOf(raw);
    return g.error ? [{ path: ["mapLocation"], message: g.error }] : [];
  }
  const p = parsePinInput(raw.mapPinLat, raw.mapPinLng);
  return p.ok ? [] : [{ path: ["mapPinLat"], message: PIN_PARSE_MESSAGES[p.error] }];
}

/** Ham harita alanları → kaydedilecek değerler (yalnız hatasız girdide çağrılır). */
export function mapFromRaw(raw: Record<string, unknown>): MapInput {
  const chosen = chosenMapMode(raw) ?? "google";
  const embedUrl = googleOf(raw).url;
  const p = parsePinInput(raw.mapPinLat, raw.mapPinLng);
  const pin = p.ok ? p.pin : null;
  return { mode: chosen, embedUrl, pin };
}

/**
 * Biçimlendirilmiş açıklama: HTML sunucuda temizlenir (description.ts); sınırlar temiz HTML'e ve
 * düz metin haline uygulanır. Görünür metin yoksa açıklama yok sayılır.
 */
const richDescription = z
  .preprocess(
    (v) => (typeof v === "string" ? sanitizeDescription(v) : v),
    z.custom<CleanDescription | undefined>(
      (v) =>
        v === undefined ||
        (typeof v === "object" &&
          v !== null &&
          typeof (v as CleanDescription).html === "string" &&
          typeof (v as CleanDescription).text === "string"),
      { error: "Açıklama geçersiz." },
    ),
  )
  .superRefine((v, ctx) => {
    if (!v) return;
    if (v.text.length > L.descriptionMax) {
      ctx.addIssue({
        code: "custom",
        message: `Açıklama en fazla ${L.descriptionMax} karakter olabilir.`,
      });
    } else if (v.html.length > L.descriptionHtmlMax) {
      ctx.addIssue({ code: "custom", message: "Açıklamada çok fazla biçimlendirme var." });
    }
  });

/** YouTube: tek video (isteğe bağlı). Çıktı video kimliği listesidir (0 veya 1 öğe). */
const youtubeUrl = z
  .preprocess(blankToUndefined, z.string().trim().max(500, "Bağlantı çok uzun.").optional())
  .transform((raw, ctx) => {
    if (raw === undefined) return [] as string[];
    const id = parseYouTubeId(raw);
    if (!id) {
      ctx.addIssue({ code: "custom", message: "Geçerli bir YouTube video bağlantısı girin." });
      return z.NEVER;
    }
    return [id];
  });

const POOL_DIMENSIONS = [
  ["Depth", "Derinlik", L.poolDepthMin, L.poolDepthMax],
  ["Width", "Genişlik", L.poolSideMin, L.poolSideMax],
  ["Length", "Uzunluk", L.poolSideMin, L.poolSideMax],
] as const;

const cap = (k: PoolKind) => (k.charAt(0).toUpperCase() + k.slice(1)) as Capitalize<PoolKind>;
export const poolField = (k: PoolKind, dim?: "Depth" | "Width" | "Length") =>
  `pool${cap(k)}${dim ?? ""}` as const;

/** "1,50" / "1.5" → 1.5; boş → undefined; geçersiz → NaN. En fazla 2 ondalık. */
function parseMeters(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().replace(",", ".");
  if (!t) return undefined;
  return /^[0-9]{1,3}(\.[0-9]{1,2})?$/.test(t) ? Number(t) : Number.NaN;
}

export type PoolInput = {
  present: boolean;
  depth: number | null;
  width: number | null;
  length: number | null;
};
export type PoolsInput = Record<PoolKind, PoolInput> & { swimmingProtected: boolean };

/** "Var" seçilen havuzların ölçü hataları (alan yollarıyla). */
function poolIssues(raw: Record<string, unknown>): Issue[] {
  const out: Issue[] = [];
  for (const k of POOL_KINDS) {
    if (raw[poolField(k)] !== "yes") continue;
    for (const [d, label, min, max] of POOL_DIMENSIONS) {
      const n = parseMeters(raw[poolField(k, d)]);
      const path = [poolField(k, d)];
      if (n === undefined) out.push({ path, message: `${label} gerekli.` });
      else if (Number.isNaN(n))
        out.push({
          path,
          message: `${label} metre cinsinden, en fazla 2 ondalıklı bir sayı olmalı (ör. 1,50).`,
        });
      else if (n < min || n > max)
        out.push({
          path,
          message: `${label} ${String(min).replace(".", ",")} ile ${max} m arasında olmalı.`,
        });
    }
  }
  return out;
}

// Ham havuz alanları: asıl denetim nesne düzeyinde (aşağıda), "var" seçiliyse yapılır.
const rawPoolFields = {
  poolSwimming: z.unknown().optional(),
  poolSwimmingDepth: z.unknown().optional(),
  poolSwimmingWidth: z.unknown().optional(),
  poolSwimmingLength: z.unknown().optional(),
  poolIndoor: z.unknown().optional(),
  poolIndoorDepth: z.unknown().optional(),
  poolIndoorWidth: z.unknown().optional(),
  poolIndoorLength: z.unknown().optional(),
  poolKids: z.unknown().optional(),
  poolKidsDepth: z.unknown().optional(),
  poolKidsWidth: z.unknown().optional(),
  poolKidsLength: z.unknown().optional(),
};

const rawMapFields = {
  mapMode: z.unknown().optional(),
  mapLocation: z.unknown().optional(),
  mapPinLat: z.unknown().optional(),
  mapPinLng: z.unknown().optional(),
};
const rawDistanceFields = Object.fromEntries(
  [...DISTANCE_KEYS, ...DISTANCE_UNIT_FIELDS].map((k) => [k, z.unknown().optional()]),
) as Record<DistanceKey | (typeof DISTANCE_UNIT_FIELDS)[number], z.ZodOptional<z.ZodUnknown>>;

const RAW_MAP_DISTANCE_KEYS = [
  ...(Object.keys(rawMapFields) as (keyof typeof rawMapFields)[]),
  ...DISTANCE_KEYS,
  ...DISTANCE_UNIT_FIELDS,
] as const;

/** Alanlar arası denetimler: havuz ölçüleri, harita yöntemi, mesafe + birim. */
const crossIssues = (raw: Record<string, unknown>): Issue[] => [
  ...poolIssues(raw),
  ...mapIssues(raw),
  ...distanceIssues(raw),
];

export const propertyInput = z
  .object({
    name: text(L.nameMin, L.nameMax, "Mülk adı"),
    propertyType: z.enum(PROPERTY_TYPES, { error: "Mülk türünü seçin." }),
    description: richDescription,
    tourismLicenseNo: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .max(L.licenseMax, `Belge numarası en fazla ${L.licenseMax} karakter olabilir.`)
        .regex(LICENSE_PATTERN, "Belge numarasında yalnız harf, rakam, boşluk, - / . kullanın.")
        .optional(),
    ),
    youtubeUrl,
    ...rawPoolFields,
    poolSwimmingProtected: z.unknown().optional(),
    maxGuests: int(L.guestsMin, L.guestsMax, "Kişi kapasitesi"),
    bedrooms: int(0, L.roomsMax, "Yatak odası sayısı"),
    bathrooms: int(0, L.roomsMax, "Banyo sayısı"),
    province: z.enum(TR_PROVINCES, { error: "İl seçin." }),
    district: text(2, L.placeMax, "İlçe"),
    neighborhood: optionalText(L.neighborhoodMax, "Mahalle / köy"),
    // Harita ve mesafeler: ham alanlar; denetim ve çeviri nesne düzeyinde (aşağıda).
    ...rawMapFields,
    ...rawDistanceFields,
  })
  .superRefine((v, ctx) => {
    for (const issue of crossIssues(v)) ctx.addIssue({ code: "custom", ...issue });
  })
  // Ham harita/mesafe alanları çıktıda yer almaz; yerlerine çevrilmiş `map` ve `distances` gelir.
  .transform((v) => {
    const out: Record<string, unknown> = { ...v };
    for (const k of RAW_MAP_DISTANCE_KEYS) delete out[k];
    return {
      ...(out as Omit<typeof v, (typeof RAW_MAP_DISTANCE_KEYS)[number]>),
      map: mapFromRaw(v),
      distances: distancesFromRaw(v),
    };
  });

/** Ham havuz alanları → yapılandırılmış havuz bilgisi ("yok" iken ölçüler yok sayılır). */
export function poolsFromRaw(raw: Record<string, unknown>): PoolsInput {
  const out = {} as PoolsInput;
  for (const k of POOL_KINDS) {
    const present = raw[poolField(k)] === "yes";
    const m = (d: "Depth" | "Width" | "Length") =>
      present ? (parseMeters(raw[poolField(k, d)]) ?? null) : null;
    out[k] = { present, depth: m("Depth"), width: m("Width"), length: m("Length") };
  }
  out.swimmingProtected = out.swimming.present && raw.poolSwimmingProtected === "yes";
  return out;
}

export type PropertyInput = z.infer<typeof propertyInput>;

/**
 * propertyInput.safeParse + alanlar arası hatalar. Zod, alan hatası varken nesne düzeyindeki
 * denetimi çalıştırmaz; havuz, harita ve mesafe hataları da diğer hatalarla tek seferde gösterilsin diye
 * başarısız sonuca eklenir.
 */
export function parsePropertyInput(input: unknown) {
  const result = propertyInput.safeParse(input);
  if (result.success || typeof input !== "object" || input === null) return result;
  const seen = new Set(result.error.issues.map((i) => i.path.join(".")));
  for (const issue of crossIssues(input as Record<string, unknown>)) {
    if (!seen.has(issue.path.join("."))) {
      result.error.issues.push({ code: "custom", input: undefined, ...issue });
    }
  }
  return result;
}

/** Formdaki alan adları (FormData → nesne). Hepsi tek değerli metindir. */
export const PROPERTY_FIELDS = [
  "name",
  "propertyType",
  "description",
  "tourismLicenseNo",
  "youtubeUrl",
  "maxGuests",
  "bedrooms",
  "bathrooms",
  "province",
  "district",
  "neighborhood",
  "mapMode",
  "mapLocation",
  "mapPinLat",
  "mapPinLng",
  ...DISTANCE_KEYS,
  ...DISTANCE_UNIT_FIELDS,
  "poolSwimming",
  "poolSwimmingDepth",
  "poolSwimmingWidth",
  "poolSwimmingLength",
  "poolSwimmingProtected",
  "poolIndoor",
  "poolIndoorDepth",
  "poolIndoorWidth",
  "poolIndoorLength",
  "poolKids",
  "poolKidsDepth",
  "poolKidsWidth",
  "poolKidsLength",
] as const satisfies readonly (keyof z.input<typeof propertyInput>)[];

export type PropertyField = (typeof PROPERTY_FIELDS)[number];

/** Form değerleri: tüm alanlar metin. */
export type PropertyFormRaw = Record<PropertyField, string>;

export function propertyFormValues(data: FormData): PropertyFormRaw {
  const out = {} as PropertyFormRaw;
  for (const k of PROPERTY_FIELDS) {
    const v = data.get(k);
    out[k] = typeof v === "string" ? v : "";
  }
  return out;
}

export const propertyStatusInput = z.enum(PROPERTY_STATUSES);
