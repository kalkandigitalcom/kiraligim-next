-- Opsiyon Aşama 2 (0064–0065: reservation_options, geçmiş ve gölge mod) — GERİ ALMA BETİĞİ
--
-- YALNIZ GEREKİRSE. Önce gölge modu kapatın (WA_OPTION_SHADOW tanımsız ya da "on" dışında bir
-- değer) ve uygulamayı 0063 koduna (167662d) döndürün; sonra yedek alın ve bu betiği app_migrator
-- (veya süper kullanıcı) ile tek transaction'da çalıştırın:
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f rollback-0064-0065.sql
--
-- Bu iki migration mevcut hiçbir tabloyu, politikayı, kısıtı, tetikleyiciyi veya fonksiyonu
-- değiştirmez; geri alma yalnız yeni nesneleri kaldırır. Rezervasyon, blok, harici takvim, iCal,
-- API ve webhook verisi ETKİLENMEZ.
--
-- KAYBOLAN VERİ: gölge mod kararları (wa_option_shadow_decisions; yalnız analiz kaydı). Opsiyon
-- kaydı (reservation_options) VARSA betik hiçbir şey yapmadan durur: Aşama 2'de opsiyon yazan kod
-- yoktur, kayıt varsa elle incelenmelidir.

-- 0. Güvenlik kontrolü (koşul sağlanmazsa hiçbir değişiklik yapılmadan hata).
DO $$
DECLARE
  v_later boolean := false;
  v_options bigint := 0;
BEGIN
  -- 0065'ten sonra migration uygulanmışsa (0065 = 1794728592586) önce onlar geri alınmalı.
  IF pg_catalog.to_regclass('drizzle.__migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM drizzle.__migrations WHERE created_at > $1)'
      INTO v_later USING 1794728592586::bigint;
  END IF;
  IF v_later THEN
    RAISE EXCEPTION 'rollback_0064_0065_blocked: 0065 sonrası migration uygulanmış'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Tablo yoksa dinamik sorgu çalıştırılmaz (PL/pgSQL statik sorguyu tablo olmadan planlayamaz).
  -- FORCE RLS: app_migrator tabloyu yalnız app.wa_calendar bayrağıyla görür; bayraksız sayım 0
  -- döner ve koruma boşa çıkar. Bayrak transaction'a yereldir.
  IF pg_catalog.to_regclass('public.reservation_options') IS NOT NULL THEN
    PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
    EXECUTE 'SELECT count(*) FROM public.reservation_options' INTO v_options;
  END IF;
  IF v_options > 0 THEN
    RAISE EXCEPTION 'rollback_0064_0065_blocked: reservation_options boş değil (% kayıt)', v_options
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

-- 1. Gölge mod fonksiyonu ve tetikleyiciler (0065).
DROP FUNCTION IF EXISTS public.app_wa_store_option_shadow(uuid, jsonb);
DROP TRIGGER IF EXISTS reservation_option_events_guard ON public.reservation_option_events;
DROP TRIGGER IF EXISTS reservation_options_history ON public.reservation_options;
DROP TRIGGER IF EXISTS reservation_options_guard ON public.reservation_options;
DROP FUNCTION IF EXISTS public.app_reservation_option_events_guard();
DROP FUNCTION IF EXISTS public.app_reservation_options_history();
DROP FUNCTION IF EXISTS public.app_reservation_options_guard();

-- 2. Tablolar (0064; politikaları ve yetkileri tabloyla birlikte kalkar). Bağımlılık sırası.
DROP TABLE IF EXISTS public.wa_option_shadow_decisions;
DROP TABLE IF EXISTS public.reservation_option_events;
DROP TABLE IF EXISTS public.reservation_options;

-- 3. Migration kaydı (0064 = 1794728536983, 0065 = 1794728592586): yeniden deploy'da tekrar uygulanır.
DO $$
BEGIN
  IF pg_catalog.to_regclass('drizzle.__migrations') IS NOT NULL THEN
    EXECUTE 'DELETE FROM drizzle.__migrations WHERE created_at IN ($1, $2)'
      USING 1794728536983::bigint, 1794728592586::bigint;
  END IF;
END
$$;
