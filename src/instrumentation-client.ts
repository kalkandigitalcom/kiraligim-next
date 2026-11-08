/**
 * İstemci başlangıcı (Next.js, hydration öncesi, eşzamanlı). Yalnız Geri/İleri kapısını kurar:
 * kaydedilmemiş değişiklik uyarısının yönlendiriciden önce çalışması için (src/lib/history-guard.ts).
 * Hiçbir koruma etkin değilken davranışı değiştirmez.
 */
import { installHistoryGate } from "@/lib/history-guard";

installHistoryGate();
