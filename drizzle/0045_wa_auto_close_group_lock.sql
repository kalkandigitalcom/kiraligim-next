-- 0045_wa_auto_close_group_lock (Aşama 2 düzeltmesi: otomatik kapatma ↔ Super Admin yarışı)
--
-- Otomatik takvim kapatma (src/server/whatsapp/auto-close.ts) blok yazmadan önce grubun hâlâ bağlı,
-- aktif ve aynı villada olduğunu denetler. 0044'te işletme rolünün (app_user) wa_groups üzerinde
-- UPDATE yetkisi kaldırıldığı için bu okuma satırı kilitleyemiyordu; denetim ile blok kaydı arasında
-- Super Admin grubu pasife alabilir, villasını değiştirebilir veya bağlantıyı kaldırabilirdi.
--
-- Bu fonksiyon grup satırını otomatik kapatma transaction'ı boyunca FOR SHARE ile kilitler. Super
-- Admin fonksiyonları (app_wa_admin_set_active / set_property / unlink_group) aynı satırı FOR UPDATE
-- ile kilitlediğinden iki işlem sıralanır:
--   - Super Admin önce davranırsa otomatik kapatma onun commit'ini bekler ve GÜNCEL durumu okur
--     (pasif / farklı villa / bağlı değil → blok yazılmaz).
--   - Otomatik kapatma önce kilitlerse Super Admin işlemi blok commit edilene kadar bekler; grup
--     değişikliği bloktan SONRA gerçekleşir.
-- Kilit sırası her iki tarafta da grup → öneri olduğu için kilitlenme (deadlock) oluşmaz.
--
-- Güvenlik: SECURITY DEFINER (sahip app_migrator), yalnız app_user çalıştırır; yalnız oturumdaki
-- işletmenin (app_current_workspace_id) grubunu kilitler ve yalnız durum + villa döndürür. İşletme
-- rolüne tablo yetkisi VERİLMEZ. Veri değiştirmez.
--
-- Geri alma: DROP FUNCTION public.app_wa_lock_group_for_auto_close(uuid);
--   (auto-close.ts önceki sürüme döner).
CREATE FUNCTION public.app_wa_lock_group_for_auto_close(p_group uuid)
  RETURNS TABLE (status text, property_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_ws uuid := public.app_current_workspace_id();
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  IF v_ws IS NOT NULL AND p_group IS NOT NULL THEN
    RETURN QUERY
      SELECT g.status, g.property_id
        FROM public.wa_groups g
       WHERE g.id = p_group AND g.workspace_id = v_ws
         FOR SHARE OF g;
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_wa_lock_group_for_auto_close(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_wa_lock_group_for_auto_close(uuid) TO app_user;
