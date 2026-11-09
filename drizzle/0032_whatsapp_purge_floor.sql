-- 0032_whatsapp_purge_floor (WhatsApp Asistanı A1 sertleştirme)
-- app_wa_purge_messages artık 90 günden kısa saklama süresini REDDEDER (önceden 1–365). Böylece
-- app_user yetkisine sahip herhangi bir bağlantı (ör. web uygulaması) mesajları 90 günden erken
-- silemez. Fonksiyon gövdesi dışındaki her şey aynı kalır: imza, dönüş tipi, SECURITY DEFINER,
-- search_path, sahip (app_migrator) ve EXECUTE yetkileri (CREATE OR REPLACE yetkileri korur;
-- emniyet için REVOKE/GRANT yeniden uygulanır). 0030 ve 0031 değişmez.
--
-- Geri alma: 0031'deki fonksiyon tanımı (p_days 1–365) yeni bir ileri migration ile yeniden
-- uygulanır; veri değişikliği yoktur.
CREATE OR REPLACE FUNCTION public.app_wa_purge_messages(p_days integer)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.wa_fn', true);
  v_count integer;
BEGIN
  -- Alt sınır: uygulama sabiti WA_RETENTION_DAYS = 90. Üst sınır 365.
  IF p_days IS NULL OR p_days < 90 OR p_days > 365 THEN
    RAISE EXCEPTION 'wa_purge_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  DELETE FROM public.wa_inbound_messages
   WHERE received_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  DELETE FROM public.wa_link_codes
   WHERE coalesce(used_at, expires_at) < pg_catalog.now() - interval '7 days';
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
  RETURN v_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_wa_purge_messages(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_wa_purge_messages(integer) TO app_user;
