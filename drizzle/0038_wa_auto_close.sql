-- 0038_wa_auto_close (WhatsApp Asistanı A2e: işletme sahibinin açık kapatma talimatı)
--
-- Amaç: villaya bağlı gruba işletme SAHİBİNİN doğrulanmış numarasından gelen, net tarihli ve
-- çakışmasız "kapat" talimatı panel onayı beklemeden takvime blok olarak işlenir. Blok, mevcut
-- rezervasyon servisiyle (createReservation: doğrulama, pasif villa, çakışma kısıtı) ve SAHİBİN
-- kendi oturum bağlamında (withTenant: üyelik ve rol yeniden doğrulanır) oluşur; öneri aynı
-- transaction'da "applied" (decision_mode = 'quick', decided_by = sahip) olur. 0035'teki
-- wa_calendar_proposals_quick_only_close kısıtı ve 0036'daki durum makinesi tetikleyicisi
-- değişmeden geçerlidir: quick yalnız nedensiz kapatmada ve yalnız oturumdaki owner/manager adına.
--
-- Bu migration YALNIZ şunu ekler: worker'ın, KİLİTLİ mesajın gönderenine karşılık gelen kullanıcıyı
-- öğrenmesi için yalnız okuyan bir fonksiyon. Hiçbir tabloya yazmaz; işletme kimliği ve numara
-- parametre olarak ALINMAZ (kilitli mesajdan bulunur). Numara veya numara özeti döndürülmez.
--
-- Ağ geçidi rolüne (app_wa_gateway) yetki verilmez.
--
-- Geri alma: DROP FUNCTION public.app_wa_message_sender(uuid, uuid);

CREATE FUNCTION public.app_wa_message_sender(p_message uuid, p_token uuid)
  RETURNS TABLE (user_id uuid, role text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_ws uuid;
  v_pn text;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  -- Yalnız geçerli kilit belirteciyle tutulan mesaj (app_wa_message_context ile aynı kural).
  SELECT m.workspace_id, m.sender_pn INTO v_ws, v_pn FROM public.wa_inbound_messages m
   WHERE m.id = p_message AND m.status = 'processing' AND m.lock_token = p_token
     AND m.locked_until > pg_catalog.clock_timestamp();
  IF v_ws IS NOT NULL AND v_pn IS NOT NULL THEN
    -- Numara özeti tekildir (wa_verified_phones_phone_key): en fazla bir kullanıcı.
    RETURN QUERY
      SELECT vp.user_id, m.role
        FROM public.wa_verified_phones vp
        JOIN public.workspace_members m ON m.user_id = vp.user_id AND m.workspace_id = v_ws
       WHERE vp.phone_hash = public.app_wa_phone_hash(v_pn)
       LIMIT 1;
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_wa_message_sender(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- Worker uygulamanın bağlantısını (app_user) kullanır; diğer worker fonksiyonlarıyla aynı model.
GRANT EXECUTE ON FUNCTION public.app_wa_message_sender(uuid, uuid) TO app_user;
