/** Super Admin WhatsApp ekranlarının etiketleri (yalnız gösterim). */
export const TAB_LABELS = {
  bekleyen: "Eşleştirme bekleyen",
  aktif: "Aktif",
  pasif: "Pasif",
  arsiv: "Arşiv / yok sayılan",
  tum: "Tümü",
} as const;

export const STATUS_LABELS: Record<string, string> = {
  discovered: "Eşleştirme bekliyor",
  linked: "Aktif",
  suspended: "Pasif",
  left: "Asistan gruptan çıkarılmış",
};

export const CONNECTION_LABELS: Record<string, string> = {
  open: "Bağlı",
  connecting: "Bağlanıyor",
  closed: "Bağlantı yok",
  logged_out: "Oturum kapalı (QR gerekli)",
};

export const HISTORY_LABELS: Record<string, string> = {
  "whatsapp.group_linked": "İşletme ve villayla eşleştirildi",
  "whatsapp.group_property_changed": "Villa değiştirildi",
  "whatsapp.group_suspended": "Pasife alındı",
  "whatsapp.group_resumed": "Yeniden aktif edildi",
  "whatsapp.group_unlinked": "Bağlantı kaldırıldı (mesajlar silindi)",
  "whatsapp.group_archived": "Arşivlendi / yok sayıldı",
  "whatsapp.group_unarchived": "Arşivden çıkarıldı",
};

export const NOTICES: Record<string, string> = {
  eslestirildi: "Grup işletme ve villayla eşleştirildi; artık aktif.",
  "villa-degisti": "Grubun villası güncellendi.",
  aktif: "Grup yeniden aktif; yeni mesajlar işlenecek.",
  pasif: "Grup pasife alındı; yeni mesajlar kaydedilmez ve otomatik işlem yapılmaz.",
  kaldirildi: "Bağlantı kaldırıldı; grubun mesajları silindi. Kayıtlar korunur.",
  arsivlendi: "Grup arşivlendi (yok sayılıyor).",
  "arsivden-cikti": "Grup arşivden çıkarıldı; yeniden eşleştirme bekliyor.",
  engellendi: "Numara engellendi; bu numaradan gelen komutlar işlenmez.",
  "engel-kalkti": "Engel kaldırıldı.",
};
