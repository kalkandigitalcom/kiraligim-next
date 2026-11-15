/** Super Admin opsiyon ekranlarının etiketleri (yalnız gösterim). */
import { OPTION_STATUS_BADGES, type OptionStatus } from "@/lib/option-meta";

export const TABS = ["onay", "acik", "kesinlesen", "iptal", "suresi-dolan", "uyarilar"] as const;
export type OptionTab = (typeof TABS)[number];

export const TAB_LABELS: Record<OptionTab, string> = {
  onay: "Onay bekleyen",
  acik: `Açık ${OPTION_STATUS_BADGES.open}`,
  kesinlesen: `Kesinleşen ${OPTION_STATUS_BADGES.converted}`,
  iptal: `İptal ${OPTION_STATUS_BADGES.cancelled}`,
  "suresi-dolan": `Süresi dolan ${OPTION_STATUS_BADGES.expired}`,
  uyarilar: "Çakışma uyarıları",
};

export const TAB_STATUS: Partial<Record<OptionTab, OptionStatus>> = {
  acik: "open",
  kesinlesen: "converted",
  iptal: "cancelled",
  "suresi-dolan": "expired",
};

export const STATUS_LABELS: Record<string, string> = {
  open: "Açık",
  converted: "Kesinleşti",
  cancelled: "İptal",
  expired: "Süresi doldu",
};

export const badge = (s: string) =>
  `${OPTION_STATUS_BADGES[s as OptionStatus] ?? ""} ${STATUS_LABELS[s] ?? s}`.trim();

export const SOURCE_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  panel: "Panel",
};

export const END_REASON_LABELS: Record<string, string> = {
  payment_received: "Ödeme alındı",
  confirmed_in_panel: "Panelde kesinleşti",
  customer_declined: "Müşteri vazgeçti",
  owner_cancelled: "Sahip iptal etti",
  panel_cancel: "Super Admin panelden iptal etti",
  expired: "Süresi doldu",
};

export const EXPIRY_SOURCE_LABELS: Record<string, string> = {
  message: "mesajda yazan süre",
  workspace_default: "işletme varsayılanı",
  manual: "Super Admin girdi",
};

export const EVENT_LABELS: Record<string, string> = {
  created: "Oluşturuldu",
  updated: "Güncellendi",
  converted: "Kesin rezervasyona dönüştü",
  cancelled: "İptal edildi",
  expired: "Süresi doldu",
};

export const OP_KIND_LABELS: Record<string, string> = {
  create: "Opsiyon oluştur",
  cancel: "Opsiyonu iptal et",
  convert: "Kesin rezervasyona dönüştür",
};

export const OP_STATUS_LABELS: Record<string, string> = {
  pending: "Onay bekliyor",
  approved: "Onaylandı — uygulanmayı bekliyor",
  applied: "Uygulandı",
  rejected: "Reddedildi",
  stale: "Uygulanmadı (takvim veya hedef değişti)",
  failed: "Uygulanamadı",
};

export const OP_MODE_LABELS: Record<string, string> = {
  auto: "otomatik",
  needs_approval: "Super Admin onayı",
};

export const FAILURE_LABELS: Record<string, string> = {
  calendar_changed: "Onaydan sonra takvim değişti",
  target_changed: "Hedef opsiyon değişti veya kapandı",
  group_changed: "WhatsApp grubunun villası / işletmesi değişti",
  not_applicable: "Koşullar uygun değil (villa pasif, süre dolmuş veya giriş tarihinden sonra)",
};

export const REASON_LABELS: Record<string, string> = {
  question: "Mesaj soru",
  negated: "Olumsuz ifade",
  hedged: "Kesin olmayan ifade",
  intent_conflict: "Çelişen niyet",
  intent_unclear: "Niyet belirsiz",
  date_missing: "Tarih yok",
  date_unclear: "Tarih belirsiz",
  date_past: "Tarih geçmişte",
  multiple_ranges: "Birden çok tarih aralığı",
  villa_unclear: "Villa belirsiz",
  duration_unclear: "Süre belirsiz",
  duration_out_of_bounds: "Süre sınır dışında (1 saat – 14 gün)",
  duration_after_check_in: "Süre girişten sonraya taşıyor",
  calendar_conflict: "Takvimde kesin kayıt var",
  option_overlap: "Başka açık opsiyonla çakışıyor",
  no_open_option: "Açık opsiyon yok",
  multiple_open_options: "Birden çok açık opsiyon",
  option_not_open: "Opsiyon açık değil",
  option_expired: "Opsiyonun süresi dolmuş",
  dateless_target_pending: "Tarihsiz hedef",
  group_without_villa: "Grubun villası yok",
  duration_missing: "Süre yazılmamış, varsayılan yok",
  guest_info_missing: "Misafir bilgisi eksik",
  automation_off: "Otomasyon kapalı",
  property_inactive: "Villa pasif",
};

export const RANGE_KIND_LABELS: Record<string, string> = {
  reservation: "Rezervasyon",
  block: "Blok",
  external: "Harici takvim",
  option: "Açık opsiyon",
};

export const RESERVATION_STATUS_LABELS: Record<string, string> = {
  pending: "beklemede",
  confirmed: "onaylı",
  cancelled: "iptal",
  active: "etkin",
  inactive: "pasif",
};

export const ALERT_SOURCE_LABELS: Record<string, string> = {
  reservation: "Kiralığım kaydı",
  external_event: "Harici takvim",
};

export const NOTICES: Record<string, string> = {
  onaylandi:
    "İşlem onaylandı. Bakım görevi anahtarlar açıkken takvimi yeniden doğrulayıp uygular; takvim değişirse uygulanmaz.",
  reddedildi: "İşlem reddedildi.",
  "iptal-edildi": "Opsiyon iptal edildi (panel_cancel). Kesin kayıtlara dokunulmadı.",
  goruldu: "Uyarı görüldü olarak işaretlendi.",
  "zaten-goruldu": "Uyarı zaten görüldü olarak işaretlenmiş.",
  "ayar-kaydedildi": "Ayar kaydedildi.",
  "ayar-ayni": "Değişiklik yok; ayar zaten bu durumda.",
};
