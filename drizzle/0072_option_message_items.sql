-- 0072_option_message_items (Opsiyon Aşama 3d: WhatsApp mesajından opsiyon oluşturma / iptal)
--
-- YALNIZ TEK YENİ FONKSİYON ekler. Tablo, sütun, kısıt, indeks, politika, tetikleyici ve mevcut
-- hiçbir fonksiyon değişmez; worker, ayrıştırıcı, ağ geçidi, tepki kuyruğu, rezervasyon, API, iCal
-- ve webhook akışları DEĞİŞMEZ.
--
-- app_option_message_items(p_message): option-maintenance görevinin (app_user) imleçle ALDIĞI
-- (option_message_scans.status = 'claimed') mesaj için worker'ın zaten kaydettiği öğeleri
-- (wa_calendar_proposals) yalnız OKUR: öğe no, ayrıştırıcı sürümü, tarih, villa ve villa çözümü,
-- işaretler, gönderen rolü ve doğrulanmış olup olmadığı. Mesaj metni, alıntı, misafir adı, telefon
-- ve gönderen özeti DÖNMEZ. Alınmamış (claimed olmayan) mesaj için hiçbir satır dönmez.
--
-- Geri alma: docs/rollback-0072.sql.

CREATE FUNCTION public.app_option_message_items(p_message uuid)
  RETURNS TABLE (item_no smallint, parser_version smallint, check_in date, check_out date,
                 property_id uuid, villa_resolution text, flags text[], sender_role text,
                 sender_verified boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
BEGIN
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  RETURN QUERY
    SELECT p.item_no, p.parser_version, p.check_in, p.check_out, p.property_id,
           p.villa_resolution, p.flags, p.sender_role, p.sender_verified
      FROM public.option_message_scans x
      JOIN public.wa_calendar_proposals p
        ON p.message_id = x.message_id AND p.workspace_id = x.workspace_id
     WHERE x.message_id = p_message AND x.status = 'claimed'
     ORDER BY p.item_no;
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_option_message_items(uuid) FROM PUBLIC;
--> statement-breakpoint
-- option-maintenance uygulamanın bağlantısını (app_user) kullanır; başka role VERİLMEZ.
GRANT EXECUTE ON FUNCTION public.app_option_message_items(uuid) TO app_user;
