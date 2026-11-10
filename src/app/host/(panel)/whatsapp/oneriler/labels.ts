/** WhatsApp önerisi ekranlarının Türkçe etiketleri (yalnız gösterim). */
export const ACTION_LABELS: Record<string, string> = {
  reserve: "Rezervasyon",
  close: "Tarihleri kapat (blok)",
  open: "Tarihleri aç",
  cancel: "İptal",
};

export const STATUS_LABELS: Record<string, string> = {
  pending: "Onay bekliyor",
  applied: "Onaylandı",
  rejected: "Reddedildi",
  superseded: "Yinelenen",
  expired: "Süresi geçti",
  noop: "İşlem yok",
};

export const REASON_LABELS: Record<string, string> = {
  no_action: "Mesajda net bir işlem yok",
  action_requires_review: "Rezervasyon/iptal/açma her zaman incelenir",
  flagged: "Ayrıştırıcı uyarısı var",
  dates_incomplete: "Tarihler eksik veya belirsiz",
  villa_unresolved: "Villa belirlenemedi",
  villa_needs_review: "Grubun villası dışında bir villa",
  sender_unverified: "Gönderen doğrulanmamış",
  staff_review_required: "Gönderen personel (staff)",
  conflict: "Takvimde çakışma var",
  low_confidence: "Güven puanı düşük",
};

export const FLAG_LABELS: Record<string, string> = {
  action_missing: "işlem sözcüğü yok",
  action_ambiguous: "çelişen işlem sözcükleri",
  question: "soru cümlesi",
  villa_missing: "villa adı yazılmamış",
  villa_ambiguous: "villa–tarih eşleşmesi belirsiz",
  villa_outside_group: "grup dışı villa",
  villa_not_found: "villa bulunamadı",
  date_missing: "tarih yok",
  date_incomplete: "tek tarih",
  date_ambiguous: "tarih belirsiz",
  date_invalid: "geçersiz tarih",
  date_past: "geçmiş tarih",
  in_progress: "devam eden konaklama",
  year_inferred: "yıl tahmin edildi",
  year_ambiguous: "yıl belirsiz",
  range_too_long: "aralık çok uzun",
  multiple_items: "mesajda birden çok işlem",
  guest_name_missing: "misafir adı yok",
  end_inclusive: "son gün dahil",
  date_change: "tarih değişikliği",
};

/** Otomatik kapatmanın uygulanamama nedenleri (A2e; öneri panel onayı bekler). */
export const AUTO_FAILURE_LABELS: Record<string, string> = {
  changed: "öneri bu arada değişti",
  conflict: "takvimde çakışma var",
  property_inactive: "villa pasif",
  invalid: "tarihler kurallara uymuyor",
  error: "beklenmeyen hata",
};

export const ROLE_LABELS: Record<string, string> = {
  owner: "İşletme sahibi",
  manager: "Yönetici",
  staff: "Personel",
};
