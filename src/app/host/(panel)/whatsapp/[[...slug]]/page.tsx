import { permanentRedirect } from "next/navigation";

/**
 * Eski WhatsApp Asistanı adresleri (/whatsapp, /whatsapp/oneriler, /whatsapp/oneriler/{id}).
 * İşletme panelinde WhatsApp modülü yoktur: grup yönetimi Super Admin'de, mesajları sistem işler.
 * Yer imleri ve eski bağlantılar ana panele yönlendirilir.
 */
export default function LegacyWhatsappRedirect(): never {
  permanentRedirect("/panel");
}
