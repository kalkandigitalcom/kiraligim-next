-- 0027_public_reservation_requests (Villa sayfasından rezervasyon talebi)
-- Misafir, yayındaki villa sayfasındaki formla rezervasyon TALEBİ gönderir. Talep MEVCUT
-- reservations tablosuna, mevcut kurallarla yazılır; ikinci bir rezervasyon sistemi yoktur:
--   kind = 'reservation', status = 'pending' (ev sahibi onaylayana kadar kesin değil),
--   source = 'web' (YENİ kaynak değeri; bu yüzden reservations_source_check genişletilir),
--   created_by = NULL (oturum yok), workspace_id / property_id yayındaki sayfanın adresinden.
-- Beklemede kayıt mevcut kuralla tarihleri KAPATIR (reservations_no_overlap, 0016; Burhan'ın
-- kararı): eşzamanlı çakışan iki talepten yalnız biri yazılır (dizin düzeyinde, RLS'ten bağımsız),
-- misafir takvimi talebi dolu gösterir; ev sahibi talebi iptal edince tarihler yeniden açılır.
--
-- Güvenlik modeli 0024 ile aynı: app_user tabloya doğrudan YAZAMAZ (reservations_insert politikası
-- işletme bağlamı ister). Tek giriş noktası SECURITY DEFINER app_public_reservation_request
-- (sahibi app_migrator, EXECUTE yalnız app_user). Fonksiyon:
--   * sayfayı adresinden bulur ve görünürlüğü (yayında + aktif + fotoğraf + WhatsApp + abonelik)
--     app_public_villa_visible ile denetler; mülk/işletme kimliği dışarıdan ALINMAZ;
--   * kişi sayısını mülk kapasitesiyle, tarihleri public pencereyle (bugün … +18 ay, en fazla 60
--     gece) denetler; fiyatı uygulama sunucuda yeniden hesaplayıp verir (istemci değeri kullanılmaz);
--   * spam sınırı: aynı villaya son 1 saatte en fazla 5, ileri tarihli açık (beklemede) en fazla
--     10 web talebi; aşılırsa 'public_request_rate_limited';
--   * yalnız tek INSERT yapar: dar politika reservations_public_request yalnız bu fonksiyonun açtığı
--     app.public_request ayarıyla ve yalnız web/beklemede/oluşturansız satıra izin verir;
--   * dönüş: yeni kaydın kimliği ve bildirim alıcıları (işletmenin e-postası doğrulanmış sahip ve
--     yöneticileri). Misafir verisi DÖNMEZ; public okuma fonksiyonları misafir alanlarını hiç okumaz.
-- Mevcut tetikleyici (app_reservations_guard) aynen çalışır: pasif mülk, tarih aralığı, iptal kuralı.
-- Geri alma: DROP FUNCTION public.app_public_reservation_request(uuid, text, date, date, integer,
--   text, text, text, text, bigint, text); DROP POLICY reservations_public_request ON
--   public.reservations; reservations_source_check'i 'web' olmadan yeniden ekleme (önce web
--   kaynaklı kayıtların kaynağı değiştirilmelidir).
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_source_check";--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_source_check" CHECK ("reservations"."source" is null or "reservations"."source" in ('direct', 'phone', 'airbnb', 'booking', 'other', 'web'));
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Dar INSERT politikası (yalnız app_migrator ve yalnız fonksiyonun açtığı ayarla)
-- ---------------------------------------------------------------------------
CREATE POLICY reservations_public_request ON public.reservations FOR INSERT TO app_migrator
  WITH CHECK (pg_catalog.current_setting('app.public_request', true) = 'on'
              AND kind = 'reservation' AND status = 'pending' AND source = 'web'
              AND created_by IS NULL AND deposit_amount_minor IS NULL
              AND public.app_public_villa_visible(property_id));
--> statement-breakpoint
CREATE FUNCTION public.app_public_reservation_request(
    p_id uuid, p_slug text, p_check_in date, p_check_out date, p_guests integer,
    p_name text, p_phone text, p_email text, p_note text,
    p_total_minor bigint, p_currency text)
  RETURNS TABLE (reservation_id uuid, notify_emails text[])
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_read text := pg_catalog.current_setting('app.public_read', true);
  v_prev_req text := pg_catalog.current_setting('app.public_request', true);
  v_today date := (pg_catalog.now() AT TIME ZONE 'Europe/Istanbul')::date;
  v_prop uuid;
  v_ws uuid;
  v_max smallint;
  v_recent integer;
  v_open integer;
  v_emails text[];
BEGIN
  IF p_id IS NULL OR p_slug IS NULL OR p_check_in IS NULL OR p_check_out IS NULL
     OR p_guests IS NULL THEN
    RAISE EXCEPTION 'public_request_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.public_read', 'on', true);
  SELECT p.id, p.workspace_id, p.max_guests INTO v_prop, v_ws, v_max
    FROM public.properties p
   WHERE p.public_slug = p_slug;
  IF v_prop IS NULL OR NOT public.app_public_villa_visible(v_prop) THEN
    RAISE EXCEPTION 'public_request_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_guests < 1 OR p_guests > v_max THEN
    RAISE EXCEPTION 'public_request_guests' USING ERRCODE = 'check_violation';
  END IF;
  IF p_check_in < v_today OR p_check_in > (v_today + interval '18 months')::date
     OR p_check_out <= p_check_in OR p_check_out - p_check_in > 60 THEN
    RAISE EXCEPTION 'public_request_dates' USING ERRCODE = 'check_violation';
  END IF;
  SELECT pg_catalog.count(*) FILTER (WHERE r.created_at > pg_catalog.now() - interval '1 hour'),
         pg_catalog.count(*) FILTER (WHERE r.status = 'pending' AND r.check_out > v_today)
    INTO v_recent, v_open
    FROM public.reservations r
   WHERE r.property_id = v_prop AND r.source = 'web';
  IF v_recent >= 5 OR v_open >= 10 THEN
    RAISE EXCEPTION 'public_request_rate_limited' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_catalog.set_config('app.public_request', 'on', true);
  INSERT INTO public.reservations (
      id, workspace_id, property_id, kind, status, source, check_in, check_out,
      guest_name, guest_phone, guest_email, adults, children,
      total_amount_minor, currency, note, created_by)
    VALUES (
      p_id, v_ws, v_prop, 'reservation', 'pending', 'web', p_check_in, p_check_out,
      p_name, p_phone, p_email, p_guests, 0,
      p_total_minor, p_currency, p_note, NULL);
  PERFORM pg_catalog.set_config('app.public_request', coalesce(v_prev_req, ''), true);

  SELECT pg_catalog.array_agg(u.email ORDER BY u.email) INTO v_emails
    FROM public.workspace_members m
    JOIN public.users u ON u.id = m.user_id
   WHERE m.workspace_id = v_ws AND m.role IN ('owner', 'manager') AND u.email_verified;
  PERFORM pg_catalog.set_config('app.public_read', coalesce(v_prev_read, ''), true);
  reservation_id := p_id;
  notify_emails := coalesce(v_emails, ARRAY[]::text[]);
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.public_read', coalesce(v_prev_read, ''), true);
  PERFORM pg_catalog.set_config('app.public_request', coalesce(v_prev_req, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_public_reservation_request(uuid, text, date, date, integer, text, text, text, text, bigint, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_public_reservation_request(uuid, text, date, date, integer, text, text, text, text, bigint, text) TO app_user;
