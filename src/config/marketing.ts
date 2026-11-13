/**
 * Tanıtım sitesi (kök alan adı) içerik ve yayın ayarları. Bağımlılıksız: sayfalar, robots/sitemap
 * ve birim testleri aynı değerleri kullanır.
 *
 * Yayın kuralları (değiştirmeden önce okuyun):
 *  - INDEXING_ENABLED false iken robots.txt her şeyi kapatır, sitemap boştur ve sayfalar noindex
 *    döner. Hukukçu onaylı KVKK, gizlilik ve kullanım koşulları metinleri yayımlanmadan AÇILMAZ.
 *    Açıldığında da indeksleme yalnız APP_ENV=production ve kök alan adında geçerlidir
 *    (proxy.ts diğer durumlarda x-robots-tag: noindex ekler).
 *  - Fiyat ve iletişim bilgisi uydurulmaz: fiyat açıklanana kadar PRICE_NOTE gösterilir;
 *    iletişim kanalı tanımlanmadıkça sitede iletişim bilgisi yer almaz.
 *  - Kayıt kapalıyken (AUTH_SIGNUP_ENABLED=false) deneme düğmeleri kayıt sayfasına gitmez;
 *    sayfadaki "Ücretsiz deneme" bölümüne iner (signupCta).
 *  - Henüz olmayan özellikler (iCal, KBS, QR rehber, ekip daveti, ödeme) "çalışıyor" diye
 *    sunulmaz; yalnız "Geliştiriliyor" başlığı altında anılır.
 */

export const INDEXING_ENABLED = false as const;

/**
 * Geçici bakım ekranı. true iken kök alan adının ana sayfası (/) tanıtım içeriği yerine yalnız
 * MAINTENANCE_COPY'yi gösterir. Yalnız tanıtım grubunu etkiler: /villa/* sayfaları, app.* ve
 * admin.* yüzeyleri, /api/* ve arka plan işleri değişmez. Geri almak için false yapın.
 */
export const SITE_MAINTENANCE: boolean = true;

export const MAINTENANCE_COPY = {
  badge: "Yenileniyoruz",
  title: "Daha iyisi için hazırlanıyoruz.",
  description:
    "Kiraligim çok yakında yeni yüzüyle sizlerle. Villa takvim yönetimini daha kolay ve güçlü hale getirmek için çalışmalarımıza devam ediyoruz.",
  footnote: "Çok yakında tekrar görüşmek üzere.",
} as const;

/** Deneme süresi (gün). Plan kaydındaki trial_days ile aynı tutulmalı (başlangıç planı). */
export const TRIAL_DAYS = 14;

export const PRICE_NOTE = "Deneme sonrası fiyat yakında açıklanacak";

/** Sayfa içi bölüm kimlikleri (başlıktaki bağlantılar ve CTA hedefleri). */
export const SECTION_IDS = {
  how: "nasil-calisir",
  features: "ozellikler",
  calculator: "fiyat-hesaplama",
  pricing: "fiyatlandirma",
  faq: "sss",
  trial: "ucretsiz-deneme",
} as const;

export const NAV_ITEMS = [
  { label: "Nasıl çalışır", href: `/#${SECTION_IDS.how}` },
  { label: "Özellikler", href: `/#${SECTION_IDS.features}` },
  { label: "Fiyat hesaplama", href: `/#${SECTION_IDS.calculator}` },
  { label: "Fiyatlandırma", href: `/#${SECTION_IDS.pricing}` },
  { label: "SSS", href: `/#${SECTION_IDS.faq}` },
] as const;

export const SITE_COPY = {
  title: "Villa ve günlük kiralık ev yönetim paneli",
  description:
    "Kiralığım; villa, apart ve günlük kiralık ev sahipleri için rezervasyon takvimini, sezonluk fiyatları ve konaklama fiyatı hesabını tek panelde toplar.",
  slogan: "Kiralamanın düzenli hâli.",
  hero: {
    eyebrow: "Villa, apart ve günlük kiralık ev sahipleri için",
    titleLead: "Kiralamanın",
    titleAccent: "düzenli",
    titleTail: "hâli.",
    lead: "Rezervasyon takvimi, sezonluk fiyatlar ve konaklama tutarı tek panelde. Kiralığım haftalık fiyatı ve temizlik ücretini kurallarınıza göre hesaplar, teklifi WhatsApp'a hazır hâle getirir.",
    secondaryCta: "Fiyat hesaplamayı deneyin",
    trust: ["Kart bilgisi gerekmez", "Kurulum gerekmez", "Telefonda da çalışır"],
  },
  trialOpenLabel: `${TRIAL_DAYS} gün ücretsiz deneyin`,
  trialSoonLabel: "Ücretsiz deneme yakında",
  trialSoonText:
    "Kayıtlar kısa süre içinde açılacak. Açıldığında ilk mülkünüzü ekleyip tüm özellikleri ücretsiz deneyebileceksiniz.",
  loginLabel: "Giriş yap",
  legalPending: "Yasal metinler hazırlanıyor.",
} as const;

/** Başlangıç planına dahil olanlar: yalnız bugün çalışan özellikler. */
export const PLAN_FEATURES = [
  "1 mülk",
  "Aylık rezervasyon takvimi ve bloklar",
  "Sezonluk fiyat dönemleri (gecelik, haftalık, minimum konaklama)",
  "Temizlik ücreti kuralı",
  "Otomatik konaklama tutarı hesabı",
  "WhatsApp'a hazır teklif metni",
  "En fazla 80 fotoğraf, mülk bilgileri ve havuz detayları",
  "Ön ödeme ve kalan tutar takibi",
] as const;

/** Geliştirme aşamasındaki özellikler: sitede yalnız "Geliştiriliyor" olarak anılır. */
export const ROADMAP_ITEMS = [
  {
    title: "Takvim senkronizasyonu (iCal)",
    text: "Airbnb ve Booking.com takvimleriyle iCal bağlantısı. Bugün kaynak bilgisini rezervasyona elle işleyebilirsiniz.",
  },
  {
    title: "Misafir bilgi formu",
    text: "Misafirin konaklama öncesi bilgilerini kendisinin doldurabileceği form.",
  },
  {
    title: "KBS bildirim takibi",
    text: "Kimlik bildirimi yapılacak konaklamaları takip etmeye yardımcı ekran. Resmî sisteme otomatik bildirim yapmaz.",
  },
  {
    title: "QR dijital rehber",
    text: "Wi-Fi, ev kuralları ve çevre önerileri için misafire QR ile açılan rehber sayfası.",
  },
] as const;

export const FAQ_ITEMS = [
  {
    q: "Kiralığım kimler için?",
    a: "Villa, apart ve günlük kiralık ev sahipleri ile bu mülkleri yöneten küçük işletmeler için. Rezervasyonlarını defterde, tabloda ya da mesajlarda takip eden herkesin işini tek panelde toplar.",
  },
  {
    q: "Ücretsiz deneme nasıl işliyor?",
    a: `Deneme süresi ${TRIAL_DAYS} gündür ve kart bilgisi istenmez. Kayıtlar kısa süre içinde açılacak; açıldığında bu sayfadaki düğmeyle başlayabilirsiniz.`,
  },
  {
    q: "Deneme sonrasında ücret ne kadar?",
    a: `${PRICE_NOTE}.`,
  },
  {
    q: "Konaklama tutarı nasıl hesaplanıyor?",
    a: "Her gece, o günün fiyat dönemiyle hesaplanır. Dönemde haftalık fiyat varsa 7 gecelik bloklara haftalık fiyat, kalan gecelere gecelik fiyat uygulanır. Bir gecenin bile fiyatı tanımlı değilse toplam gösterilmez; neyin eksik olduğu söylenir.",
  },
  {
    q: "Temizlik ücreti nasıl uygulanıyor?",
    a: "Her fiyat dönemi için bir temizlik ücreti ve isterseniz 'şu gece sayısından itibaren ücretsiz' sınırı tanımlarsınız. Ücret, giriş gecesinin dönemine göre konaklama başına bir kez ve ayrı kalem olarak eklenir.",
  },
  {
    q: "Hesaplanan tutar rezervasyona kendiliğinden yazılır mı?",
    a: "Hayır. Tutar rezervasyon formunda önerilir; yalnız siz 'Bu tutarı kullan' derseniz forma aktarılır. Kayıtlı rezervasyonların tutarları fiyat değişikliklerinden etkilenmez.",
  },
  {
    q: "Airbnb veya Booking.com takvimimi bağlayabilir miyim?",
    a: "Henüz değil. iCal senkronizasyonu geliştirme aşamasında. Bugün rezervasyonun kaynağını (Airbnb, Booking.com, telefon, doğrudan) kayda işleyebilir ve tüm rezervasyonları tek takvimde görebilirsiniz.",
  },
  {
    q: "KBS bildirimini Kiralığım mı yapıyor?",
    a: "Hayır. Kiralığım bugün resmî KBS sistemine bağlı değildir ve bildirim yapmaz. Bildirim takibine yardımcı bir ekran geliştirme aşamasındadır.",
  },
  {
    q: "Telefondan kullanabilir miyim?",
    a: "Evet. Kiralığım tarayıcıda çalışır, uygulama indirmeniz gerekmez. Takvim, rezervasyon ve fiyat hesabı telefon ekranına göre düzenlenir.",
  },
  {
    q: "Birden fazla mülkümü yönetebilir miyim?",
    a: "Başlangıç planı tek mülk içindir. Diğer plan seçenekleri fiyatlandırmayla birlikte duyurulacak.",
  },
] as const;

export type SignupCta = { href: string; label: string; external: boolean; open: boolean };

/**
 * Deneme düğmesinin hedefi. Kayıt açıksa panel alan adındaki kayıt sayfası; kapalıysa (ya da kimlik
 * sistemi kullanılamıyorsa) sayfadaki deneme bölümü. Kapalı kayıt akışına asla bağlanmaz.
 */
export function signupCta(signupOpen: boolean, appUrl: string): SignupCta {
  if (signupOpen) {
    return {
      href: new URL("/kayit", appUrl).toString(),
      label: SITE_COPY.trialOpenLabel,
      external: true,
      open: true,
    };
  }
  return {
    href: `/#${SECTION_IDS.trial}`,
    label: SITE_COPY.trialSoonLabel,
    external: false,
    open: false,
  };
}

export const loginHref = (appUrl: string) => new URL("/giris", appUrl).toString();

/** Tanıtım sitesinin yolları (sitemap). Yasal sayfalar metinleri onaylanınca eklenir. */
export const SITE_PATHS = ["/"] as const;

type RobotsRule = { userAgent: string; allow?: string; disallow?: string };
export type RobotsPolicy = { rules: RobotsRule[]; sitemap?: string };

/**
 * robots.txt kararı. İndeksleme yalnız üç koşul birlikteyken açılır: INDEXING_ENABLED,
 * production ortamı ve isteğin kök (tanıtım) alan adına gelmesi. Panel ve yönetim alan adları
 * her zaman kapalıdır.
 */
export function robotsPolicy(opts: {
  indexingEnabled: boolean;
  isProduction: boolean;
  isSiteHost: boolean;
  publicUrl: string;
}): RobotsPolicy {
  if (opts.indexingEnabled && opts.isProduction && opts.isSiteHost) {
    return {
      rules: [{ userAgent: "*", allow: "/" }],
      sitemap: new URL("/sitemap.xml", opts.publicUrl).toString(),
    };
  }
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}

export function sitemapUrls(opts: {
  indexingEnabled: boolean;
  isProduction: boolean;
  isSiteHost: boolean;
  publicUrl: string;
}): string[] {
  if (!(opts.indexingEnabled && opts.isProduction && opts.isSiteHost)) return [];
  return SITE_PATHS.map((p) => new URL(p, opts.publicUrl).toString());
}
