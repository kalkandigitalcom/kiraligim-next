-- 0025_villa_details_expand (Villa sihirbazı revizyonu — İKİ AŞAMALI GEÇİŞİN 1. AŞAMASI: genişletme)
-- Yeni alanlar: Google Haritalar gömme adresi, yakın yerlere 7 mesafe (km), hazır ev kuralları ve
-- fiyata dahil olanlar. ESKİ KOLONLAR BU AŞAMADA KALIR (address_line, postal_code, latitude,
-- longitude, beds_double, beds_single, beds_sofa): yeni uygulama kodu onları okumaz/yazmaz;
-- değerleri korunur. Kaldırma 2. aşama migration'ındadır (yeni kod üretimde doğrulandıktan sonra).
-- Mevcut kayıtlar etkilenmez: yeni kolonlar NULL ya da boş dizi varsayılanlıdır (tablo yeniden
-- yazılmaz) ve yeni CHECK kısıtlarını karşılar.
-- Yetkiler: yalnız app_user'a kolon düzeyinde (harita/mesafe: INSERT+UPDATE; kurallar ve dahil
-- olanlar: UPDATE — olanaklar gibi). RLS politikaları DEĞİŞMEZ (staff yine yazamaz).
-- app_public_villa: dönüş kolonları değiştiği için yeniden oluşturulur. Güvenlik modeli 0024 ile
-- aynıdır (SECURITY DEFINER, sabit kolon listesi, app.public_read ayarı, EXECUTE yalnız app_user).
-- Yatak kolonları artık DÖNMEZ; harita, mesafeler, kurallar ve dahil olanlar döner. Açık adres,
-- posta kodu ve koordinat önceden de dönmüyordu, yine dönmez.
-- Geri alma: DROP FUNCTION public.app_public_villa(text) ve 0024'teki tanımla yeniden oluşturma;
--   REVOKE INSERT (...), UPDATE (...) ON public.properties FROM app_user; ALTER TABLE
--   public.properties DROP CONSTRAINT properties_map_embed_url, properties_distances,
--   properties_house_rule_keys, properties_price_includes; DROP COLUMN map_embed_url,
--   distance_*_km (7), house_rule_keys, price_includes.
ALTER TABLE "properties" ADD COLUMN "map_embed_url" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "distance_market_km" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "distance_restaurant_km" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "distance_center_km" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "distance_beach_km" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "distance_airport_ayt_km" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "distance_airport_dlm_km" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "distance_health_km" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "house_rule_keys" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "price_includes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_map_embed_url" CHECK ("properties"."map_embed_url" is null or (length("properties"."map_embed_url") <= 2000 and "properties"."map_embed_url" ~ '^https://www\.google\.com/maps(/embed\?pb=[A-Za-z0-9!._%:~*+-]+|\?q=-?[0-9]{1,2}\.[0-9]{1,6},-?[0-9]{1,3}\.[0-9]{1,6}&z=16&output=embed)$'));--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_distances" CHECK (("properties"."distance_market_km" is null or ("properties"."distance_market_km" > 0 and "properties"."distance_market_km" <= 9999.99)) and ("properties"."distance_restaurant_km" is null or ("properties"."distance_restaurant_km" > 0 and "properties"."distance_restaurant_km" <= 9999.99)) and ("properties"."distance_center_km" is null or ("properties"."distance_center_km" > 0 and "properties"."distance_center_km" <= 9999.99)) and ("properties"."distance_beach_km" is null or ("properties"."distance_beach_km" > 0 and "properties"."distance_beach_km" <= 9999.99)) and ("properties"."distance_airport_ayt_km" is null or ("properties"."distance_airport_ayt_km" > 0 and "properties"."distance_airport_ayt_km" <= 9999.99)) and ("properties"."distance_airport_dlm_km" is null or ("properties"."distance_airport_dlm_km" > 0 and "properties"."distance_airport_dlm_km" <= 9999.99)) and ("properties"."distance_health_km" is null or ("properties"."distance_health_km" > 0 and "properties"."distance_health_km" <= 9999.99)));--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_house_rule_keys" CHECK (cardinality("properties"."house_rule_keys") <= 20 and array_position("properties"."house_rule_keys", null) is null and (cardinality("properties"."house_rule_keys") = 0 or array_to_string("properties"."house_rule_keys", ',') ~ '^[a-z][a-z0-9-]{1,31}(,[a-z][a-z0-9-]{1,31})*$'));--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_price_includes" CHECK (cardinality("properties"."price_includes") <= 20 and array_position("properties"."price_includes", null) is null and (cardinality("properties"."price_includes") = 0 or array_to_string("properties"."price_includes", ',') ~ '^[a-z][a-z0-9-]{1,31}(,[a-z][a-z0-9-]{1,31})*$'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Kolon düzeyinde yetkiler (yalnız app_user)
-- ---------------------------------------------------------------------------
GRANT INSERT (map_embed_url, distance_market_km, distance_restaurant_km, distance_center_km,
              distance_beach_km, distance_airport_ayt_km, distance_airport_dlm_km,
              distance_health_km)
  ON TABLE public.properties TO app_user;
--> statement-breakpoint
GRANT UPDATE (map_embed_url, distance_market_km, distance_restaurant_km, distance_center_km,
              distance_beach_km, distance_airport_ayt_km, distance_airport_dlm_km,
              distance_health_km, house_rule_keys, price_includes)
  ON TABLE public.properties TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Villa bilgisi (public okuma): yeni kolon listesi. Yatak kolonları çıkarıldı.
-- ---------------------------------------------------------------------------
DROP FUNCTION public.app_public_villa(text);
--> statement-breakpoint
CREATE FUNCTION public.app_public_villa(p_slug text)
  RETURNS TABLE (
    property_id uuid, name text, property_type text,
    description text, description_html text, youtube_video_ids text[],
    max_guests smallint, bedrooms smallint, bathrooms smallint,
    province text, district text, neighborhood text,
    map_embed_url text,
    distance_market_km numeric, distance_restaurant_km numeric, distance_center_km numeric,
    distance_beach_km numeric, distance_airport_ayt_km numeric, distance_airport_dlm_km numeric,
    distance_health_km numeric,
    pool_swimming boolean, pool_swimming_depth numeric, pool_swimming_width numeric,
    pool_swimming_length numeric, pool_swimming_protected boolean,
    pool_indoor boolean, pool_indoor_depth numeric, pool_indoor_width numeric,
    pool_indoor_length numeric,
    pool_kids boolean, pool_kids_depth numeric, pool_kids_width numeric, pool_kids_length numeric,
    amenities text[], check_in_time text, check_out_time text,
    house_rules text, house_rule_keys text[], price_includes text[],
    cancellation_policy text, payment_terms text,
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
           p.province, p.district, p.neighborhood,
           p.map_embed_url,
           p.distance_market_km, p.distance_restaurant_km, p.distance_center_km,
           p.distance_beach_km, p.distance_airport_ayt_km, p.distance_airport_dlm_km,
           p.distance_health_km,
           p.pool_swimming, p.pool_swimming_depth, p.pool_swimming_width,
           p.pool_swimming_length, p.pool_swimming_protected,
           p.pool_indoor, p.pool_indoor_depth, p.pool_indoor_width, p.pool_indoor_length,
           p.pool_kids, p.pool_kids_depth, p.pool_kids_width, p.pool_kids_length,
           p.amenities, pg_catalog.to_char(p.check_in_time, 'HH24:MI'),
           pg_catalog.to_char(p.check_out_time, 'HH24:MI'),
           p.house_rules, p.house_rule_keys, p.price_includes,
           p.cancellation_policy, p.payment_terms,
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
REVOKE ALL ON FUNCTION public.app_public_villa(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_public_villa(text) TO app_user;
