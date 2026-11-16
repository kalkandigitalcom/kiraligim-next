-- 0074_option_shared_automation (Opsiyon: tek ve ortak opsiyon sistemi)
--
-- YALNIZ mevcut app_option_automation_since(uuid) fonksiyonunun GÖVDESİ değişir (CREATE OR REPLACE:
-- ad, imza, dönüş tipi, SECURITY DEFINER, sahibi, sabit search_path ve yetkileri AYNI). Tablo,
-- sütun, kısıt, indeks, politika, tetikleyici ve başka hiçbir fonksiyon değişmez; veri silinmez.
--
-- Eski kural (0067): global + işletme (workspace_option_settings.automation_enabled) + grup
-- (wa_group_option_settings.enabled) anahtarlarının ÜÇÜ de açık olmalıydı.
-- Yeni kural: global anahtar (acil durum kill switch'i) açıksa, bağlı (linked), villası atanmış ve
-- işletmesi aktif HER WhatsApp grubunda opsiyon otomasyonu kendiliğinden çalışır. İşletme ve grup
-- anahtarları artık aranmaz (tablolar ve değerleri korunur; işletmenin varsayılan süresi ve süre
-- seçenekleri aynen kullanılır).
--
-- Bu fonksiyonu kullanan bütün yollar (mesaj imleci, mesaj işleme, onaylı işlem / kesinleştirme
-- alma ve uygulama, panel sayaçları) app_option_automation_since / app_option_automation_enabled
-- üzerinden yeni kurala geçer; o fonksiyonların kendisi değişmez.
--
-- Korunanlar: global kapalıyken hiçbir mesaj okunmaz ve onaylı işlem uygulanmaz; dönüş değeri
-- (otomasyonun hangi andan beri açık olduğu = global anahtarın son değişikliği ile grubun bağlanma
-- anının büyüğü) sayesinde global kapalıyken ya da grup bağlanmadan ÖNCE gelen mesajlar geriye
-- dönük işlenmez. Bağlantısı kaldırılmış, askıya alınmış, villasız ya da işletmesi askıdaki grup
-- işlem yapamaz. Gönderen yetkisi (doğrulanmış sahip / yönetici), engelli numaralar, villa / işletme
-- değişikliğinde eski işlemlerin uygulanmaması (group_changed) ve opsiyonların müsaitliği
-- etkilememesi değişmez.
--
-- Geri alma: docs/rollback-0074.sql (0067 gövdesini birebir geri yükler).

CREATE OR REPLACE FUNCTION public.app_option_automation_since(p_group uuid) RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  v_since timestamptz;
BEGIN
  IF p_group IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  -- Tek ortak sistem (0074): işletme ve grup anahtarı aranmaz. Grup bağlı (linked), villası atanmış,
  -- işletmesi aktif ve global anahtar açıksa otomasyon etkindir.
  SELECT GREATEST(o.updated_at, g.linked_at)
    INTO v_since
    FROM public.wa_groups g
    JOIN public.workspaces w ON w.id = g.workspace_id
    JOIN public.option_automation_global o ON o.id = 1
   WHERE g.id = p_group AND g.status = 'linked' AND g.property_id IS NOT NULL
     AND g.linked_at IS NOT NULL AND w.status = 'active'
     AND o.enabled;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RETURN v_since;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
