/**
 * Müşteriye açık villa sayfası (Aşama F1): sabitler ve saf yardımcılar. Bağımlılıksız: Drizzle
 * şeması (CHECK kısıtları), Zod, servis ve panel bileşenleri aynı değerleri kullanır.
 *
 * Sayfa adresi: kiraligim.com/villa/{publicSlug}. Slug mülk düzeyindedir ve tüm sistemde benzersizdir
 * (veritabanı benzersizlik indeksi). Sayfanın gerçekten açık olması için sahibin yayınlamış olması
 * YETMEZ; mülk aktif, adres dolu, en az bir fotoğraf, işletme WhatsApp numarası ve geçerli abonelik
 * gerekir (pageVisibility). F2'deki public okuma da aynı kuralı uygular.
 */
import { slugify } from "./slug";

export const PUBLIC_PROFILE_LIMITS = {
  slugMin: 3,
  slugMax: 60,
  amenitiesMax: 40,
  houseRulesMax: 2000,
  cancellationPolicyMax: 2000,
  paymentTermsMax: 1000,
} as const;

/** Slug biçimi: küçük harf, rakam ve tek tire; tire ile başlamaz/bitmez. Veritabanı CHECK'iyle aynı. */
export const PUBLIC_SLUG_PATTERN = "^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$";
const SLUG_RE = new RegExp(PUBLIC_SLUG_PATTERN);

/**
 * Ayrılmış adresler: site, panel ve ileride açılacak sayfalarla karışabilecek kelimeler. Veritabanı
 * CHECK'i aynı listeyle yazılır (src/db/schema/properties.ts); eşitliği birim testi denetler.
 */
export const RESERVED_PUBLIC_SLUGS = [
  "admin",
  "api",
  "app",
  "www",
  "villa",
  "villalar",
  "giris",
  "kayit",
  "cikis",
  "panel",
  "yeni",
  "duzenle",
  "onizleme",
  "rezervasyon",
  "rezervasyonlar",
  "talep",
  "talepler",
  "takvim",
  "fiyat",
  "fiyatlar",
  "iletisim",
  "kvkk",
  "gizlilik",
  "kullanim-kosullari",
  "cerez",
  "cerezler",
  "hakkimizda",
  "sss",
  "yardim",
  "destek",
  "blog",
  "rehber",
  "kiraligim",
  "robots",
  "sitemap",
  "static",
  "medya",
  "test",
  "demo",
  "ornek",
  "null",
  "undefined",
] as const;

const RESERVED = new Set<string>(RESERVED_PUBLIC_SLUGS);

export type SlugProblem = "format" | "double_dash" | "reserved";

/** Slug kurallarını denetler; geçerliyse null. */
export function slugProblem(slug: string): SlugProblem | null {
  if (!SLUG_RE.test(slug)) return "format";
  if (slug.includes("--")) return "double_dash";
  if (RESERVED.has(slug)) return "reserved";
  return null;
}

export const SLUG_PROBLEM_MESSAGES: Record<SlugProblem, string> = {
  format: `Adres ${PUBLIC_PROFILE_LIMITS.slugMin}–${PUBLIC_PROFILE_LIMITS.slugMax} karakter olmalı; yalnız küçük harf, rakam ve tire kullanılabilir, tire ile başlayamaz veya bitemez.`,
  double_dash: "Adreste art arda iki tire kullanılamaz.",
  reserved: "Bu adres sistem tarafından ayrılmıştır; başka bir adres seçin.",
};

/** Mülk adı ve ilçeden adres önerisi: "Villa Defne" + "Kaş" → "villa-defne-kas". */
export function suggestPublicSlug(name: string, district?: string | null): string {
  const base = slugify([name, district].filter(Boolean).join(" ")).slice(
    0,
    PUBLIC_PROFILE_LIMITS.slugMax,
  );
  const trimmed = base.replace(/-+/g, "-").replace(/-+$/g, "");
  if (trimmed.length >= PUBLIC_PROFILE_LIMITS.slugMin && !RESERVED.has(trimmed)) return trimmed;
  return trimmed.length >= PUBLIC_PROFILE_LIMITS.slugMin ? `${trimmed}-villa` : "";
}

/** Müşteriye gidecek tam adres: PUBLIC_URL + /villa/{slug}. */
export const publicVillaUrl = (publicUrl: string, slug: string) =>
  new URL(`/villa/${slug}`, publicUrl).toString();

/** WhatsApp'ta paylaşım metni (misafire gönderilecek). */
export const shareMessage = (propertyName: string, url: string) =>
  `${propertyName} için villa sayfamızı inceleyebilirsiniz: ${url}`;

// ---------------------------------------------------------------------------
// Olanaklar (sabit katalog; yeni tablo yok). Veritabanında yalnız anahtarlar saklanır.
// Havuzlar burada değil: mevcut havuz alanlarından gösterilir.
// ---------------------------------------------------------------------------

/**
 * Kategoriler (Revizyon 2: "Genel" kaldırıldı, seçenekler anlamlı gruplara dağıtıldı). Kayıtta
 * yalnız anahtar saklandığı için gruplama değişikliği veri taşıması gerektirmez; anahtarlar aynı.
 */
export const AMENITY_GROUPS = [
  {
    key: "konfor",
    label: "İklimlendirme",
    items: [
      ["klima", "Klima"],
      ["isitma", "Isıtma"],
      ["somine", "Şömine"],
    ],
  },
  {
    key: "eglence",
    label: "İnternet ve eğlence",
    items: [
      ["wifi", "Wi-Fi"],
      ["televizyon", "Televizyon"],
      ["calisma-alani", "Çalışma alanı"],
    ],
  },
  {
    key: "mutfak",
    label: "Mutfak",
    items: [
      ["tam-mutfak", "Tam donanımlı mutfak"],
      ["bulasik-makinesi", "Bulaşık makinesi"],
      ["firin", "Fırın"],
      ["mikrodalga", "Mikrodalga"],
      ["kahve-makinesi", "Kahve makinesi"],
      ["buzdolabi", "Buzdolabı"],
    ],
  },
  {
    key: "banyo",
    label: "Banyo ve çamaşır",
    items: [
      ["havlu-nevresim", "Havlu ve nevresim"],
      ["sac-kurutma", "Saç kurutma makinesi"],
      ["camasir-makinesi", "Çamaşır makinesi"],
      ["kurutma-makinesi", "Kurutma makinesi"],
      ["utu", "Ütü"],
    ],
  },
  {
    key: "havuz",
    label: "Havuz başı ve spa",
    items: [
      ["sezlong", "Şezlong"],
      ["dis-dus", "Dış duş"],
      ["jakuzi", "Jakuzi"],
      ["sauna", "Sauna / hamam"],
    ],
  },
  {
    key: "dis-alan",
    label: "Dış mekân",
    items: [
      ["bahce", "Bahçe"],
      ["teras", "Teras / balkon"],
      ["barbeku", "Barbekü"],
      ["otopark", "Otopark"],
    ],
  },
  {
    key: "manzara",
    label: "Manzara ve mahremiyet",
    items: [
      ["deniz-manzarasi", "Deniz manzarası"],
      ["doga-manzarasi", "Doğa manzarası"],
      ["muhafazakar", "Muhafazakâr (dışarıdan görünmez)"],
    ],
  },
  {
    key: "aile",
    label: "Aile ve evcil hayvan",
    items: [
      ["bebek-yatagi", "Bebek yatağı"],
      ["mama-sandalyesi", "Mama sandalyesi"],
      ["evcil-hayvan", "Evcil hayvan kabul edilir"],
    ],
  },
  {
    key: "guvenlik",
    label: "Güvenlik",
    items: [
      ["guvenlik-kamerasi", "Dış alan güvenlik kamerası"],
      ["yangin-sondurucu", "Yangın söndürücü"],
      ["ilk-yardim", "İlk yardım çantası"],
      ["duman-dedektoru", "Duman dedektörü"],
    ],
  },
] as const;

export type AmenityKey = (typeof AMENITY_GROUPS)[number]["items"][number][0];

export const AMENITY_LABELS: Record<string, string> = Object.fromEntries(
  AMENITY_GROUPS.flatMap((g) => g.items.map(([k, l]) => [k, l])),
);

export const AMENITY_KEYS = Object.keys(AMENITY_LABELS) as AmenityKey[];

/** Anahtar biçimi (veritabanı CHECK'i). Katalog dışı anahtar uygulamada reddedilir. */
export const AMENITY_KEY_PATTERN = "^[a-z][a-z0-9-]{1,31}$";

export const isAmenityKey = (k: string): k is AmenityKey => k in AMENITY_LABELS;

/** Katalog sırasıyla, tekrarsız; bilinmeyen anahtarlar atlanır (gösterim için). */
export function orderAmenities(keys: readonly string[]): AmenityKey[] {
  const set = new Set(keys);
  return AMENITY_KEYS.filter((k) => set.has(k));
}

// ---------------------------------------------------------------------------
// İşletme WhatsApp numarası
// ---------------------------------------------------------------------------

export const WHATSAPP_PATTERN = "^\\+[1-9][0-9]{9,14}$";
const WHATSAPP_RE = new RegExp(WHATSAPP_PATTERN);

/**
 * Girilen numarayı uluslararası biçime çevirir: "0532 123 45 67" → "+905321234567".
 * Türkiye numaraları (0 ile ya da 5 ile başlayan) +90 ile tamamlanır; geçersizse null.
 */
export function normalizeWhatsapp(input: string): string | null {
  const raw = input.trim().replace(/[\s().-]/g, "");
  if (raw === "") return null;
  let n: string;
  if (/^\+\d+$/.test(raw)) n = raw;
  else if (/^00\d+$/.test(raw)) n = `+${raw.slice(2)}`;
  else if (/^0\d{10}$/.test(raw)) n = `+90${raw.slice(1)}`;
  else if (/^5\d{9}$/.test(raw)) n = `+90${raw}`;
  else if (/^90\d{10}$/.test(raw)) n = `+${raw}`;
  else return null;
  if (!WHATSAPP_RE.test(n)) return null;
  if (n.startsWith("+90") && n.length !== 13) return null;
  return n;
}

/** Gösterim: "+905321234567" → "+90 532 123 45 67" (diğer ülkeler olduğu gibi). */
export function formatWhatsapp(n: string): string {
  const m = /^\+90(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(n);
  return m ? `+90 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : n;
}

// ---------------------------------------------------------------------------
// Yayın durumu
// ---------------------------------------------------------------------------

export type PublishRequirement = "active" | "slug" | "photo" | "whatsapp" | "subscription";

export const PUBLISH_REQUIREMENTS: readonly PublishRequirement[] = [
  "active",
  "slug",
  "photo",
  "whatsapp",
  "subscription",
];

export const PUBLISH_REQUIREMENT_LABELS: Record<PublishRequirement, string> = {
  active: "Mülk aktif",
  slug: "Sayfa adresi kaydedildi",
  photo: "En az bir fotoğraf",
  whatsapp: "İşletme WhatsApp numarası",
  subscription: "Abonelik geçerli",
};

export type VisibilityInput = {
  isPublic: boolean;
  propertyActive: boolean;
  slug: string | null;
  photoCount: number;
  hasWhatsapp: boolean;
  subscriptionCurrent: boolean;
};

/** Karşılanmayan yayın koşulları (sırayla). Boşsa yayınlanabilir. */
export function unmetRequirements(v: VisibilityInput): PublishRequirement[] {
  const met: Record<PublishRequirement, boolean> = {
    active: v.propertyActive,
    slug: v.slug !== null && v.slug !== "",
    photo: v.photoCount > 0,
    whatsapp: v.hasWhatsapp,
    subscription: v.subscriptionCurrent,
  };
  return PUBLISH_REQUIREMENTS.filter((r) => !met[r]);
}

export type PageVisibility =
  | { state: "published" }
  | { state: "draft"; unmet: PublishRequirement[] }
  /** Sahip yayınladı ama koşullardan biri artık sağlanmıyor: sayfa müşteriye kapalı (404). */
  | { state: "closed"; unmet: PublishRequirement[] };

export function pageVisibility(v: VisibilityInput): PageVisibility {
  const unmet = unmetRequirements(v);
  if (!v.isPublic) return { state: "draft", unmet };
  return unmet.length === 0 ? { state: "published" } : { state: "closed", unmet };
}

// ---------------------------------------------------------------------------
// Saat
// ---------------------------------------------------------------------------

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "16:00" biçimini doğrular; veritabanından gelen "16:00:00" değerini "16:00"a çevirir. */
export function toHhMm(value: string | null): string | null {
  if (value === null) return null;
  const v = value.length === 8 ? value.slice(0, 5) : value;
  return TIME_RE.test(v) ? v : null;
}

export const isHhMm = (v: string) => TIME_RE.test(v);

/** Kontrol karakteri (satır sonu ve sekme hariç). Veritabanı CHECK'iyle aynı aralık. */
export const CONTROL_CHARS_RE = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
