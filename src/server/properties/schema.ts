import { z } from "zod";

import {
  LICENSE_PATTERN,
  PROPERTY_LIMITS as L,
  POOL_KINDS,
  type PoolKind,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
} from "@/lib/property-meta";
import { TR_PROVINCES } from "@/lib/tr-provinces";
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

const intDefaultZero = (max: number, label: string) =>
  z.preprocess((v) => (blankToUndefined(v) === undefined ? 0 : v), int(0, max, label));

const coordinate = (min: number, max: number, label: string) =>
  z.preprocess(
    (v) => (typeof v === "string" ? (blankToUndefined(v.replace(",", ".")) ?? undefined) : v),
    z.coerce
      .number({ error: `${label} bir sayı olmalı.` })
      .min(min, `${label} ${min} ile ${max} arasında olmalı.`)
      .max(max, `${label} ${min} ile ${max} arasında olmalı.`)
      // Veritabanı numeric(9,6): 6 ondalık basamağa yuvarlanır.
      .transform((n) => Math.round(n * 1e6) / 1e6)
      .optional(),
  );

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

/**
 * YouTube: boş satırlar yok sayılır; her bağlantı ayrı doğrulanır (hata yolu: youtubeUrls.<sıra>).
 * Çıktı video kimlikleridir.
 */
const youtubeUrls = z
  .preprocess(
    (v) => (v === undefined ? [] : typeof v === "string" ? [v] : v),
    z.array(z.string().max(500, "Bağlantı çok uzun.")),
  )
  .transform((urls, ctx) => {
    const ids: string[] = [];
    urls.forEach((raw, i) => {
      if (!raw.trim()) return;
      const id = parseYouTubeId(raw);
      if (!id) {
        ctx.addIssue({
          code: "custom",
          path: [i],
          message: "Geçerli bir YouTube video bağlantısı girin.",
        });
      } else if (ids.includes(id)) {
        ctx.addIssue({ code: "custom", path: [i], message: "Bu video zaten eklendi." });
      } else {
        ids.push(id);
      }
    });
    if (ids.length > L.youtubeMax) {
      ctx.addIssue({ code: "custom", message: `En fazla ${L.youtubeMax} video eklenebilir.` });
    }
    return ids;
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
function poolIssues(raw: Record<string, unknown>): { path: string[]; message: string }[] {
  const out: { path: string[]; message: string }[] = [];
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
    youtubeUrls,
    ...rawPoolFields,
    poolSwimmingProtected: z.unknown().optional(),
    maxGuests: int(L.guestsMin, L.guestsMax, "Kişi kapasitesi"),
    bedrooms: int(0, L.roomsMax, "Yatak odası sayısı"),
    bathrooms: int(0, L.roomsMax, "Banyo sayısı"),
    bedsDouble: intDefaultZero(L.bedsMax, "Çift kişilik yatak"),
    bedsSingle: intDefaultZero(L.bedsMax, "Tek kişilik yatak"),
    bedsSofa: intDefaultZero(L.bedsMax, "Çekyat / kanepe yatak"),
    province: z.enum(TR_PROVINCES, { error: "İl seçin." }),
    district: text(2, L.placeMax, "İlçe"),
    neighborhood: optionalText(L.neighborhoodMax, "Mahalle / köy"),
    addressLine: optionalText(L.addressMax, "Açık adres"),
    postalCode: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .regex(/^[0-9]{5}$/, "Posta kodu 5 haneli olmalı.")
        .optional(),
    ),
    latitude: coordinate(-90, 90, "Enlem"),
    longitude: coordinate(-180, 180, "Boylam"),
  })
  .superRefine((v, ctx) => {
    for (const issue of poolIssues(v)) ctx.addIssue({ code: "custom", ...issue });
  })
  .superRefine((v, ctx) => {
    if ((v.latitude === undefined) !== (v.longitude === undefined)) {
      const path = v.latitude === undefined ? "latitude" : "longitude";
      ctx.addIssue({
        code: "custom",
        path: [path],
        message: "Enlem ve boylam birlikte girilmeli.",
      });
    }
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
 * propertyInput.safeParse + havuz hataları. Zod, alan hatası varken nesne düzeyindeki denetimi
 * çalıştırmaz; havuz ölçü hataları da diğer hatalarla birlikte tek seferde gösterilsin diye
 * başarısız sonuca eklenir.
 */
export function parsePropertyInput(input: unknown) {
  const result = propertyInput.safeParse(input);
  if (result.success || typeof input !== "object" || input === null) return result;
  const seen = new Set(result.error.issues.map((i) => i.path.join(".")));
  for (const issue of poolIssues(input as Record<string, unknown>)) {
    if (!seen.has(issue.path.join("."))) {
      result.error.issues.push({ code: "custom", input: undefined, ...issue });
    }
  }
  return result;
}

/** Formdaki alan adları (FormData → nesne). */
export const PROPERTY_FIELDS = [
  "name",
  "propertyType",
  "description",
  "tourismLicenseNo",
  "maxGuests",
  "bedrooms",
  "bathrooms",
  "bedsDouble",
  "bedsSingle",
  "bedsSofa",
  "province",
  "district",
  "neighborhood",
  "addressLine",
  "postalCode",
  "latitude",
  "longitude",
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
] as const satisfies readonly (keyof PropertyInput)[];

export type PropertyField = (typeof PROPERTY_FIELDS)[number];

/** Form değerleri: tek değerli alanlar metin, YouTube bağlantıları liste. */
export type PropertyFormRaw = Record<PropertyField, string> & { youtubeUrls: string[] };

export function propertyFormValues(data: FormData): PropertyFormRaw {
  const out = {} as PropertyFormRaw;
  for (const k of PROPERTY_FIELDS) {
    const v = data.get(k);
    out[k] = typeof v === "string" ? v : "";
  }
  out.youtubeUrls = data
    .getAll("youtubeUrls")
    .filter((v): v is string => typeof v === "string")
    .slice(0, 50);
  return out;
}

export const propertyStatusInput = z.enum(PROPERTY_STATUSES);
