/**
 * Mülk bilgileri sihirbazı (panel yeniden tasarımı, Aşama 3): adımlar ve her adımın alanları.
 * Bağımlılıksız: sayfa, istemci bileşenleri, server action ve testler aynı listeyi kullanır.
 *
 * Her adım YALNIZ kendi alanlarını gönderir ve kaydeder; diğer alanlar sunucuda kayıttaki
 * değerlerle tamamlanır (src/server/properties/property-fields.ts).
 */

export const WIZARD_STEPS = ["temel", "aciklama", "olanaklar", "konaklama", "kontrol"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** Bilgi giren adımlar (kontrol adımı yalnız özettir). */
export type EditStep = Exclude<WizardStep, "kontrol">;

export const WIZARD_STEP_LABELS: Record<WizardStep, string> = {
  temel: "Temel bilgiler",
  aciklama: "Açıklama ve fotoğraflar",
  olanaklar: "Olanaklar",
  konaklama: "Konaklama bilgileri",
  kontrol: "Kontrol ve tamamlama",
};

/** Adım başlığının altındaki kısa yönlendirme. */
export const WIZARD_STEP_INTROS: Record<WizardStep, string> = {
  temel: "Villanızın adını, yerini ve kaç kişiyi ağırlayabildiğini girin.",
  aciklama: "Misafirlerinize villanızı anlatın ve fotoğraflarını ekleyin.",
  olanaklar: "Villanızda bulunan olanakları işaretleyin.",
  konaklama: "Giriş-çıkış saatlerini ve misafirlerin bilmesi gereken koşulları yazın.",
  kontrol: "Bilgilerinizi gözden geçirin; eksik kalan yerleri tamamlayın.",
};

export const isWizardStep = (v: unknown): v is WizardStep =>
  typeof v === "string" && (WIZARD_STEPS as readonly string[]).includes(v);

/** `?adim=` değeri; geçersiz veya boşsa mevcut mülk için kontrol adımı. */
export function parseWizardStep(v: unknown): WizardStep {
  const s = Array.isArray(v) ? v[0] : v;
  return isWizardStep(s) ? s : "kontrol";
}

export const stepIndex = (s: WizardStep) => WIZARD_STEPS.indexOf(s);
export const nextStep = (s: WizardStep): WizardStep | null =>
  WIZARD_STEPS[stepIndex(s) + 1] ?? null;
export const prevStep = (s: WizardStep): WizardStep | null =>
  stepIndex(s) > 0 ? WIZARD_STEPS[stepIndex(s) - 1]! : null;

export const stepHref = (propertyId: string, s: WizardStep) => `/villalar/${propertyId}?adim=${s}`;

const POOL_FIELDS = [
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
] as const;

/** Adım 1: temel bilgiler + "Yalnız sizin için" bölümü. */
export const BASICS_FIELDS = [
  "name",
  "propertyType",
  "province",
  "district",
  "neighborhood",
  "maxGuests",
  "bedrooms",
  "bathrooms",
  "bedsDouble",
  "bedsSingle",
  "bedsSofa",
  "addressLine",
  "postalCode",
  "latitude",
  "longitude",
  "tourismLicenseNo",
] as const;

/** "Yalnız sizin için" bölümündeki alanlar (misafire gösterilmez). */
export const PRIVATE_FIELDS = [
  "addressLine",
  "postalCode",
  "latitude",
  "longitude",
  "tourismLicenseNo",
] as const;

/** Mülk alanları (properties tablosu) adım bazında. YouTube listesi 2. adımdadır. */
export const STEP_PROPERTY_FIELDS: Record<EditStep, readonly string[]> = {
  temel: BASICS_FIELDS,
  aciklama: ["description"],
  olanaklar: POOL_FIELDS,
  konaklama: [],
};

/** Konaklama/olanak alanları (sayfa ayarları) adım bazında. */
export const STEP_STAY_FIELDS: Record<EditStep, readonly string[]> = {
  temel: [],
  aciklama: [],
  olanaklar: ["amenities"],
  konaklama: ["checkInTime", "checkOutTime", "houseRules", "cancellationPolicy", "paymentTerms"],
};

/** Hata alanı → adım ("youtubeUrls.2" gibi sıralı anahtarlar dahil). */
export function stepOfField(field: string): EditStep | null {
  const base = field.split(".")[0]!;
  if (base === "youtubeUrls") return "aciklama";
  for (const s of ["temel", "aciklama", "olanaklar", "konaklama"] as const) {
    if (STEP_PROPERTY_FIELDS[s].includes(base) || STEP_STAY_FIELDS[s].includes(base)) return s;
  }
  return null;
}

const text = (data: FormData, k: string) => {
  const v = data.get(k);
  return typeof v === "string" ? v : "";
};

/**
 * FormData'dan YALNIZ bu adımın alanları. Adımda olmayan alanlar hiç eklenmez; böylece sunucuda
 * kayıttaki değerleri ezmezler (boş metin "sil" anlamına gelir, eksik alan "dokunma").
 */
export function wizardFormValues(
  step: EditStep,
  data: FormData,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const k of STEP_PROPERTY_FIELDS[step]) out[k] = text(data, k);
  for (const k of STEP_STAY_FIELDS[step]) {
    out[k] =
      k === "amenities"
        ? data.getAll(k).filter((v): v is string => typeof v === "string")
        : text(data, k);
  }
  if (step === "aciklama") {
    out.youtubeUrls = data
      .getAll("youtubeUrls")
      .filter((v): v is string => typeof v === "string")
      .slice(0, 50);
  }
  return out;
}

/** Yeni mülk: 1. adımda girilmeyen alanların başlangıç değerleri (havuz yok, açıklama boş). */
export const EMPTY_PROPERTY_VALUES = {
  name: "",
  propertyType: "villa",
  description: "",
  tourismLicenseNo: "",
  youtubeUrls: [] as string[],
  maxGuests: "",
  bedrooms: "",
  bathrooms: "",
  bedsDouble: "0",
  bedsSingle: "0",
  bedsSofa: "0",
  province: "",
  district: "",
  neighborhood: "",
  addressLine: "",
  postalCode: "",
  latitude: "",
  longitude: "",
  poolSwimming: "no",
  poolSwimmingDepth: "",
  poolSwimmingWidth: "",
  poolSwimmingLength: "",
  poolSwimmingProtected: "no",
  poolIndoor: "no",
  poolIndoorDepth: "",
  poolIndoorWidth: "",
  poolIndoorLength: "",
  poolKids: "no",
  poolKidsDepth: "",
  poolKidsWidth: "",
  poolKidsLength: "",
};

/** Kaydedilmemiş değişiklik uyarısı. */
export const UNSAVED_MESSAGE =
  "Kaydetmediğiniz değişiklikler var. Sayfadan ayrılırsanız bu değişiklikler kaybolacak. Devam etmek istiyor musunuz?";
