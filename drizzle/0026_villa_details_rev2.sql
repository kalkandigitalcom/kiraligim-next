-- 0026_villa_details_rev2 (Villa bilgileri — Revizyon 2, GENİŞLETME; veri kaybı yok)
-- 1) Harita için iki yöntem: map_mode ('google' | 'pin'; seçili yöntemin verisi yoksa harita
--    gösterilmez; NULL = Revizyon 2 öncesi kayıt) ve iğne koordinatları map_pin_lat / map_pin_lng
--    (OpenStreetMap / Leaflet; ikisi birlikte dolu ya da boş). Mevcut
--    map_embed_url ve kuralları DEĞİŞMEZ. Eski kayıtlar güncellenmez: uygulama map_mode NULL ve
--    Google adresi varsa Google haritasını gösterir (önceki davranış); kayıt bir sonraki
--    kaydedilişinde yöntemi açıkça yazar. Eski address/latitude/longitude kolonları KULLANILMAZ
--    (ayrı tutulan daraltma migration'ı onları kaldırır).
-- 2) Mesafe birimi: 7 adet distance_*_unit ('km' | 'm'; NULL = girilmemiş veya eski kayıt).
--    Değer kayıtta km olarak kalır; hassasiyet numeric(6,2) → numeric(8,3) GENİŞLER (1 m
--    çözünürlük). Genişletme mevcut değerleri birebir korur (2 ondalık → 3 ondalık, ör. 0.35 →
--    0.350); tablo yeniden yazılır (kısa süreli ACCESS EXCLUSIVE kilit; satır sayısı küçük).
--    Eski kayıtlar güncellenmez: birim NULL iken uygulama önceki otomatik gösterimi sürdürür
--    (1 km altı metre). Bu migration'da VERİ GÜNCELLEMESİ (UPDATE) YOKTUR: properties FORCE RLS
--    altında olduğu için migration rolüyle yapılacak toplu güncelleme satırları göremezdi.
-- 3) app_public_villa: dönüş kolonları değiştiği için yeniden oluşturulur. Güvenlik modeli 0024/0025
--    ile aynıdır (SECURITY DEFINER, sabit kolon listesi, app.public_read, EXECUTE yalnız app_user).
--    Yeni döner: map_mode, map_pin_lat, map_pin_lng, distance_*_unit. Artık DÖNMEZ:
--    cancellation_policy, payment_terms (Revizyon 2'de kaldırıldı; kolonlar ve verileri bu
--    migration'da KORUNUR, kaldırma ayrı tutulan daraltma migration'ındadır).
-- Yetkiler: yeni kolonlara yalnız app_user'a kolon düzeyinde INSERT + UPDATE (0025'teki harita ve
-- mesafe kolonlarıyla aynı). RLS politikaları DEĞİŞMEZ (staff yine yazamaz).
-- Geri alma: DROP FUNCTION public.app_public_villa(text) ve 0025'teki tanımla yeniden oluşturma;
--   REVOKE INSERT (...), UPDATE (...) yeni kolonlar ON public.properties FROM app_user;
--   ALTER TABLE public.properties DROP CONSTRAINT properties_map_mode, properties_map_pin,
--   properties_distance_units; DROP COLUMN map_mode, map_pin_lat, map_pin_lng, distance_*_unit (7).
--   Hassasiyeti numeric(6,2)'ye geri çevirmek 3. ondalığı yuvarlar (metre girişleri 10 m'ye).
ALTER TABLE "properties" ALTER COLUMN "distance_market_km" SET DATA TYPE numeric(8, 3);--> statement-breakpoint
ALTER TABLE "properties" ALTER COLUMN "distance_restaurant_km" SET DATA TYPE numeric(8, 3);--> statement-breakpoint
ALTER TABLE "properties" ALTER COLUMN "distance_center_km" SET DATA TYPE numeric(8, 3);--> statement-breakpoint
ALTER TABLE "properties" ALTER COLUMN "distance_beach_km" SET DATA TYPE numeric(8, 3);--> statement-breakpoint
ALTER TABLE "properties" ALTER COLUMN "distance_airport_ayt_km" SET DATA TYPE numeric(8, 3);--> statement-breakpoint
ALTER TABLE "properties" ALTER COLUMN "distance_airport_dlm_km" SET DATA TYPE numeric(8, 3);--> statement-breakpoint
ALTER TABLE "properties" ALTER COLUMN "distance_health_km" SET DATA TYPE numeric(8, 3);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "map_mode" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "map_pin_lat" numeric(8, 6);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "map_pin_lng" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "distance_market_unit" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "distance_restaurant_unit" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "distance_center_unit" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "distance_beach_unit" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "distance_airport_ayt_unit" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "distance_airport_dlm_unit" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "distance_health_unit" text;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_map_mode" CHECK ("properties"."map_mode" is null or "properties"."map_mode" in ('google', 'pin'));--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_map_pin" CHECK (("properties"."map_pin_lat" is null and "properties"."map_pin_lng" is null) or ("properties"."map_pin_lat" is not null and "properties"."map_pin_lng" is not null and "properties"."map_pin_lat" between -90 and 90 and "properties"."map_pin_lng" between -180 and 180 and not ("properties"."map_pin_lat" = 0 and "properties"."map_pin_lng" = 0)));--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_distance_units" CHECK (("properties"."distance_market_unit" is null or ("properties"."distance_market_unit" in ('km', 'm') and "properties"."distance_market_km" is not null)) and ("properties"."distance_restaurant_unit" is null or ("properties"."distance_restaurant_unit" in ('km', 'm') and "properties"."distance_restaurant_km" is not null)) and ("properties"."distance_center_unit" is null or ("properties"."distance_center_unit" in ('km', 'm') and "properties"."distance_center_km" is not null)) and ("properties"."distance_beach_unit" is null or ("properties"."distance_beach_unit" in ('km', 'm') and "properties"."distance_beach_km" is not null)) and ("properties"."distance_airport_ayt_unit" is null or ("properties"."distance_airport_ayt_unit" in ('km', 'm') and "properties"."distance_airport_ayt_km" is not null)) and ("properties"."distance_airport_dlm_unit" is null or ("properties"."distance_airport_dlm_unit" in ('km', 'm') and "properties"."distance_airport_dlm_km" is not null)) and ("properties"."distance_health_unit" is null or ("properties"."distance_health_unit" in ('km', 'm') and "properties"."distance_health_km" is not null)));
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Kolon düzeyinde yetkiler (yalnız app_user)
-- ---------------------------------------------------------------------------
GRANT INSERT (map_mode, map_pin_lat, map_pin_lng,
              distance_market_unit, distance_restaurant_unit, distance_center_unit,
              distance_beach_unit, distance_airport_ayt_unit, distance_airport_dlm_unit,
              distance_health_unit)
  ON TABLE public.properties TO app_user;
--> statement-breakpoint
GRANT UPDATE (map_mode, map_pin_lat, map_pin_lng,
              distance_market_unit, distance_restaurant_unit, distance_center_unit,
              distance_beach_unit, distance_airport_ayt_unit, distance_airport_dlm_unit,
              distance_health_unit)
  ON TABLE public.properties TO app_user;
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Public okuma: app_public_villa (dönüş kolonları değişti → DROP + CREATE)
-- ---------------------------------------------------------------------------
DROP FUNCTION public.app_public_villa(text);
--> statement-breakpoint
CREATE FUNCTION public.app_public_villa(p_slug text)
  RETURNS TABLE (
    property_id uuid, name text, property_type text,
    description text, description_html text, youtube_video_ids text[],
    max_guests smallint, bedrooms smallint, bathrooms smallint,
    province text, district text, neighborhood text,
    map_mode text, map_embed_url text, map_pin_lat numeric, map_pin_lng numeric,
    distance_market_km numeric, distance_restaurant_km numeric, distance_center_km numeric,
    distance_beach_km numeric, distance_airport_ayt_km numeric, distance_airport_dlm_km numeric,
    distance_health_km numeric,
    distance_market_unit text, distance_restaurant_unit text, distance_center_unit text,
    distance_beach_unit text, distance_airport_ayt_unit text, distance_airport_dlm_unit text,
    distance_health_unit text,
    pool_swimming boolean, pool_swimming_depth numeric, pool_swimming_width numeric,
    pool_swimming_length numeric, pool_swimming_protected boolean,
    pool_indoor boolean, pool_indoor_depth numeric, pool_indoor_width numeric,
    pool_indoor_length numeric,
    pool_kids boolean, pool_kids_depth numeric, pool_kids_width numeric, pool_kids_length numeric,
    amenities text[], check_in_time text, check_out_time text,
    house_rules text, house_rule_keys text[], price_includes text[],
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
           p.map_mode, p.map_embed_url, p.map_pin_lat, p.map_pin_lng,
           p.distance_market_km, p.distance_restaurant_km, p.distance_center_km,
           p.distance_beach_km, p.distance_airport_ayt_km, p.distance_airport_dlm_km,
           p.distance_health_km,
           p.distance_market_unit, p.distance_restaurant_unit, p.distance_center_unit,
           p.distance_beach_unit, p.distance_airport_ayt_unit, p.distance_airport_dlm_unit,
           p.distance_health_unit,
           p.pool_swimming, p.pool_swimming_depth, p.pool_swimming_width,
           p.pool_swimming_length, p.pool_swimming_protected,
           p.pool_indoor, p.pool_indoor_depth, p.pool_indoor_width, p.pool_indoor_length,
           p.pool_kids, p.pool_kids_depth, p.pool_kids_width, p.pool_kids_length,
           p.amenities, pg_catalog.to_char(p.check_in_time, 'HH24:MI'),
           pg_catalog.to_char(p.check_out_time, 'HH24:MI'),
           p.house_rules, p.house_rule_keys, p.price_includes,
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
