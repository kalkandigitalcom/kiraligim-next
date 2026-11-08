-- 0024_public_villa_read (Aşama F2a: müşteriye açık villa sayfası — public okuma katmanı)
--
-- Oturumsuz ziyaretçi için TEK okuma yolu: aşağıdaki dört SECURITY DEFINER fonksiyon (sahibi
-- app_migrator; EXECUTE yalnız app_user'a, PUBLIC'e kapalı). Fonksiyonlar yalnız SABİT kolon
-- listeleri döndürür; misafir adı/telefonu/e-postası, rezervasyon durumu/notu/tutarı, açık adres,
-- posta kodu, koordinat, belge numarası, işletme kimliği ve adı ASLA dönmez.
--
-- Görünürlük (src/lib/public-profile-meta.ts → pageVisibility ile aynı kural): mülk yayında
-- (is_public), aktif, adresi var, en az bir fotoğrafı var; işletme aktif ve WhatsApp numarası
-- tanımlı; abonelik geçerli. Koşullardan biri sağlanmazsa fonksiyonlar boş döner (sayfa 404).
--
-- RLS: mevcut politikalar DEĞİŞMEZ; app_user yetkileri GENİŞLEMEZ. FORCE RLS tablo sahibini de
-- kapsadığından fonksiyonların okuyabilmesi için app_migrator'a YALNIZ SELECT yapan dar
-- politikalar eklenir (belgelenmiş istisna; benzerleri: members_migrator_lookup,
-- subscriptions_migrator_trial_insert). Politikalar yalnız app.public_read = 'on' iken geçerlidir;
-- bu ayarı okuma fonksiyonları kendi gövdelerinde açar ve dönmeden önce önceki değerine geri
-- alır (hata durumunda da). Migration ve diğer app_migrator işlemleri (ayar kapalı) hiçbir yeni
-- satır görmez; app_user ayarı kendisi açsa bile politikalar ona uygulanmaz. Alt tablolar yalnız
-- yayındaki mülklere bağlı satırlarla sınırlıdır (properties politikası başka tabloya bakmaz:
-- politika özyinelemesi yok).
--
-- Geri alma: DROP FUNCTION public.app_public_villa(text), public.app_public_villa_photos(uuid),
--   public.app_public_villa_rates(uuid), public.app_public_villa_busy(uuid, date, date),
--   public.app_public_villa_visible(uuid); DROP POLICY properties_public_read ON public.properties;
--   DROP POLICY workspaces_public_read ON public.workspaces; DROP POLICY
--   subscriptions_public_read ON public.workspace_subscriptions; DROP POLICY
--   property_photos_public_read ON public.property_photos; DROP POLICY property_rates_public_read
--   ON public.property_rates; DROP POLICY reservations_public_read ON public.reservations;

-- ---------------------------------------------------------------------------
-- 1. app_migrator için dar SELECT politikaları (yalnız public okuma fonksiyonları içinde)
-- ---------------------------------------------------------------------------
CREATE POLICY properties_public_read ON public.properties FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.public_read', true) = 'on'
         AND is_public AND status = 'active' AND public_slug IS NOT NULL);
--> statement-breakpoint
CREATE POLICY workspaces_public_read ON public.workspaces FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.public_read', true) = 'on'
         AND status = 'active'
         AND EXISTS (SELECT 1 FROM public.properties p WHERE p.workspace_id = workspaces.id));
--> statement-breakpoint
CREATE POLICY subscriptions_public_read ON public.workspace_subscriptions FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.public_read', true) = 'on'
         AND EXISTS (SELECT 1 FROM public.properties p
                      WHERE p.workspace_id = workspace_subscriptions.workspace_id));
--> statement-breakpoint
CREATE POLICY property_photos_public_read ON public.property_photos FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.public_read', true) = 'on'
         AND EXISTS (SELECT 1 FROM public.properties p
                      WHERE p.id = property_photos.property_id
                        AND p.workspace_id = property_photos.workspace_id));
--> statement-breakpoint
CREATE POLICY property_rates_public_read ON public.property_rates FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.public_read', true) = 'on'
         AND EXISTS (SELECT 1 FROM public.properties p
                      WHERE p.id = property_rates.property_id
                        AND p.workspace_id = property_rates.workspace_id));
--> statement-breakpoint
CREATE POLICY reservations_public_read ON public.reservations FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.public_read', true) = 'on'
         AND status IN ('pending', 'confirmed')
         AND EXISTS (SELECT 1 FROM public.properties p
                      WHERE p.id = reservations.property_id
                        AND p.workspace_id = reservations.workspace_id));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Görünürlük. YALNIZ okuma fonksiyonlarının içinden çağrılır (app_user'a EXECUTE yok);
--    ayarı kendisi açmaz: çağıranın açtığı ayar olmadan politikalar hiçbir satır göstermez.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_public_villa_visible(p_property uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.properties p
      JOIN public.workspaces w ON w.id = p.workspace_id
      JOIN public.workspace_subscriptions s ON s.workspace_id = p.workspace_id
     WHERE p.id = p_property
       AND p.is_public AND p.status = 'active' AND p.public_slug IS NOT NULL
       AND w.status = 'active' AND w.contact_whatsapp IS NOT NULL
       AND public.app_subscription_is_current(s.status, s.trial_ends_at, s.current_period_end)
       AND EXISTS (SELECT 1 FROM public.property_photos f
                    WHERE f.property_id = p.id AND f.workspace_id = p.workspace_id))
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Villa bilgisi (adrese göre). Sabit kolon listesi; saatler metin olarak.
--    Okuma fonksiyonları: app.public_read ayarını açar, sorguyu çalıştırır, önceki değere döner.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_public_villa(p_slug text)
  RETURNS TABLE (
    property_id uuid, name text, property_type text,
    description text, description_html text, youtube_video_ids text[],
    max_guests smallint, bedrooms smallint, bathrooms smallint,
    beds_double smallint, beds_single smallint, beds_sofa smallint,
    province text, district text, neighborhood text,
    pool_swimming boolean, pool_swimming_depth numeric, pool_swimming_width numeric,
    pool_swimming_length numeric, pool_swimming_protected boolean,
    pool_indoor boolean, pool_indoor_depth numeric, pool_indoor_width numeric,
    pool_indoor_length numeric,
    pool_kids boolean, pool_kids_depth numeric, pool_kids_width numeric, pool_kids_length numeric,
    amenities text[], check_in_time text, check_out_time text,
    house_rules text, cancellation_policy text, payment_terms text,
    contact_whatsapp text, updated_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.public_read', true);
BEGIN
  PERFORM pg_catalog.set_config('app.public_read', 'on', true);
  RETURN QUERY
    SELECT p.id, p.name, p.property_type,
           p.description, p.description_html, p.youtube_video_ids,
           p.max_guests, p.bedrooms, p.bathrooms,
           p.beds_double, p.beds_single, p.beds_sofa,
           p.province, p.district, p.neighborhood,
           p.pool_swimming, p.pool_swimming_depth, p.pool_swimming_width,
           p.pool_swimming_length, p.pool_swimming_protected,
           p.pool_indoor, p.pool_indoor_depth, p.pool_indoor_width, p.pool_indoor_length,
           p.pool_kids, p.pool_kids_depth, p.pool_kids_width, p.pool_kids_length,
           p.amenities, pg_catalog.to_char(p.check_in_time, 'HH24:MI'),
           pg_catalog.to_char(p.check_out_time, 'HH24:MI'),
           p.house_rules, p.cancellation_policy, p.payment_terms,
           w.contact_whatsapp, p.updated_at
      FROM public.properties p
      JOIN public.workspaces w ON w.id = p.workspace_id
     WHERE p.public_slug = p_slug
       AND public.app_public_villa_visible(p.id);
  PERFORM pg_catalog.set_config('app.public_read', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.public_read', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Fotoğraflar (kapak önce, sonra sıra). Yalnız depolama öneki ve boyut.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_public_villa_photos(p_property uuid)
  RETURNS TABLE (storage_prefix text, width integer, height integer, is_cover boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.public_read', true);
BEGIN
  PERFORM pg_catalog.set_config('app.public_read', 'on', true);
  IF public.app_public_villa_visible(p_property) THEN
    RETURN QUERY
      SELECT f.storage_prefix, f.width, f.height, f.is_cover
        FROM public.property_photos f
       WHERE f.property_id = p_property
       ORDER BY f.is_cover DESC, f.sort_order, f.id
       LIMIT 80;
  END IF;
  PERFORM pg_catalog.set_config('app.public_read', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.public_read', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Fiyat dönemleri: bugünü kapsayan ve sonraki dönemler (Europe/Istanbul), ufuk bugün + 18 ay
--    + 61 gün; dönem kimliği ve oluşturan dönmez.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_public_villa_rates(p_property uuid)
  RETURNS TABLE (
    start_date text, end_date text, nightly_amount_minor bigint, weekly_amount_minor bigint,
    currency text, min_nights smallint, cleaning_fee_minor bigint,
    cleaning_fee_free_nights smallint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.public_read', true);
  v_today date := (pg_catalog.now() AT TIME ZONE 'Europe/Istanbul')::date;
BEGIN
  PERFORM pg_catalog.set_config('app.public_read', 'on', true);
  IF public.app_public_villa_visible(p_property) THEN
    RETURN QUERY
      SELECT pg_catalog.to_char(r.start_date, 'YYYY-MM-DD'),
             pg_catalog.to_char(r.end_date, 'YYYY-MM-DD'),
             r.nightly_amount_minor, r.weekly_amount_minor, r.currency::text, r.min_nights,
             r.cleaning_fee_minor, r.cleaning_fee_free_nights
        FROM public.property_rates r
       WHERE r.property_id = p_property
         AND r.end_date > v_today
         AND r.start_date < (v_today + interval '18 months')::date + 61
       ORDER BY r.start_date;
  END IF;
  PERFORM pg_catalog.set_config('app.public_read', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.public_read', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Dolu tarihler: beklemede + onaylı rezervasyonlar ve bloklar AYRIM YAPILMADAN, birleşik
--    [giriş, çıkış) aralıkları olarak; pencereye kırpılır. Ad, durum, tür, not, tutar dönmez.
--    Pencere en geniş [bugün − 1, bugün + 18 ay + 61]; ters/boş pencere boş sonuç.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_public_villa_busy(p_property uuid, p_from date, p_to date)
  RETURNS TABLE (start_date text, end_date text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.public_read', true);
  v_today date := (pg_catalog.now() AT TIME ZONE 'Europe/Istanbul')::date;
  v_from date;
  v_to date;
BEGIN
  IF p_from IS NULL OR p_to IS NULL THEN
    RETURN;
  END IF;
  v_from := GREATEST(p_from, v_today - 1);
  v_to := LEAST(p_to, (v_today + interval '18 months')::date + 61);
  IF v_from >= v_to THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.public_read', 'on', true);
  IF public.app_public_villa_visible(p_property) THEN
    RETURN QUERY
      WITH merged AS (
        SELECT pg_catalog.unnest(pg_catalog.range_agg(
                 pg_catalog.daterange(r.check_in, r.check_out, '[)')
                 * pg_catalog.daterange(v_from, v_to, '[)'))) AS b
          FROM public.reservations r
         WHERE r.property_id = p_property
           AND r.status IN ('pending', 'confirmed')
           AND r.check_in < v_to AND r.check_out > v_from
      )
      SELECT pg_catalog.to_char(pg_catalog.lower(m.b), 'YYYY-MM-DD'),
             pg_catalog.to_char(pg_catalog.upper(m.b), 'YYYY-MM-DD')
        FROM merged m
       WHERE NOT pg_catalog.isempty(m.b)
       ORDER BY pg_catalog.lower(m.b);
  END IF;
  PERFORM pg_catalog.set_config('app.public_read', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.public_read', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. Yetkiler: PUBLIC'e kapalı; yalnız dört okuma fonksiyonu app_user'a.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_public_villa_visible(uuid), public.app_public_villa(text),
  public.app_public_villa_photos(uuid), public.app_public_villa_rates(uuid),
  public.app_public_villa_busy(uuid, date, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_public_villa(text), public.app_public_villa_photos(uuid),
  public.app_public_villa_rates(uuid), public.app_public_villa_busy(uuid, date, date) TO app_user;
