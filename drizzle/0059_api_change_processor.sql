-- 0059_api_change_processor (API 2. aşama, 4. adım: değişiklik işlemcisi + HMAC cursor imzası)
--
--   1. Cursor imzası standart HMAC-SHA256'ya (RFC 2104) geçer. pgcrypto gerekmez: HMAC, yerleşik
--      sha256() ile tanımına göre hesaplanır (app_api_hmac_sha256; RFC 4231 test vektörleriyle ve
--      Node crypto.createHmac ile doğrulanır). app_api_cursor_mac aynı imzayla yeniden tanımlanır;
--      0058 dosyası değişmez. (0058 henüz yayında değil; önceden verilmiş cursor yoktur.)
--
--   2. İşlemci: app_api_process_changes(p_max_properties). READ COMMITTED, tek transaction:
--        a) UPDATE api_sync_state (satır kilidi): snapshot'lar (FOR SHARE) ve diğer işlemci
--           çağrıları beklenir; bu transaction bitene kadar snapshot alınamaz.
--        b) Sırası gelmiş (next_attempt_at boş ya da geçmiş) "değişti" satırı olan villalar, en eski
--           satıra göre sırayla, en fazla p_max_properties villa.
--        c) Her villa ayrı alt transaction'da (BEGIN … EXCEPTION), TEK ifade: villanın sırası gelmiş
--           satırları DELETE … RETURNING, aralıklar range_agg ile birleştirilip (çakışan ve bitişik)
--           API penceresine (366 gün geri, 731 gün ileri) kırpılır, her birleşik aralık için güncel
--           doluluk app_api_busy_json ile (aynı ifadenin veri anından) hesaplanıp
--           api_calendar_changes'e yazılır. Villanın ETKİN bağlantısı yoksa satırlar yalnız silinir.
--           DELETE yalnız ifadenin başında kaydedilmiş satırları görür: işlem sürerken eklenen
--           satırlar silinmez, sonraki çalıştırmada işlenir.
--        d) Villada hata: alt transaction geri alınır (silinen satırlar geri gelir, yazılan kayıt
--           kalmaz); satırların attempts'i artar, next_attempt_at = şimdi + min(10 sn · 2^attempts,
--           1 saat), last_error = SQLSTATE. Diğer villalar işlenmeye devam eder. Satır hiçbir zaman
--           silinmez (dead-letter yok): en geç saatte bir yeniden denenir.
--        e) last_change_id = en büyük değişiklik kimliği (aynı transaction). Kimlikler yalnız bu
--           kilit altında atandığı için kayıt sırasıyla artar; geri alınan kimlikler boşluk bırakır
--           (cursor "büyüktür" ile çalışır, sorun değildir).
--      Çökme / bağlantı kopması / rollback: transaction'ın tamamı geri alınır — "değişti" satırları
--      eksiksiz kalır, hiçbir değişiklik kaydı görünmez.
--
--   3. Saklama: app_api_prune_changes() 31 günden eski değişiklik kayıtlarını siler ve
--      pruned_through_id'yi ilerletir (aynı kilit altında). Cursor ömrü 30 gündür; 1 günlük pay,
--      geçerli bir cursor'ın sonrasındaki hiçbir kaydın silinmemesini garanti eder.
--
--   4. Eşzamanlı işlemci: süreç düzeyinde oturum advisory lock (dist/api-sync.js); veritabanında
--      ayrıca api_sync_state satır kilidi — iki çağrı aynı anda gelse de sırayla çalışır, aynı satır
--      iki kez işlenmez.
--
--   5. api_calendar_dirty'ye işlemci için okuma/silme/güncelleme politikası ('app.api_fn').
--      Tetikleyicilerin ekleme politikası (0054) değişmez.
--
-- Geri alma: DROP FUNCTION app_api_process_changes(integer), app_api_prune_changes(),
--   app_api_hmac_sha256(bytea, bytea); DROP POLICY api_calendar_dirty_api_fn ON api_calendar_dirty;
--   app_api_cursor_mac'i 0058 tanımıyla yeniden oluşturun.

-- ---------------------------------------------------------------------------
-- 1. HMAC-SHA256 ve cursor imzası
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_api_hmac_sha256(p_key bytea, p_message bytea)
  RETURNS bytea
  LANGUAGE plpgsql IMMUTABLE STRICT
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_key bytea := p_key;
  v_ipad bytea;
  v_opad bytea;
  i integer;
BEGIN
  IF pg_catalog.length(v_key) > 64 THEN
    v_key := pg_catalog.sha256(v_key);
  END IF;
  v_key := v_key || pg_catalog.decode(pg_catalog.repeat('00', 64 - pg_catalog.length(v_key)), 'hex');
  v_ipad := v_key;
  v_opad := v_key;
  FOR i IN 0..63 LOOP
    v_ipad := pg_catalog.set_byte(v_ipad, i, pg_catalog.get_byte(v_key, i) # 54);   -- 0x36
    v_opad := pg_catalog.set_byte(v_opad, i, pg_catalog.get_byte(v_key, i) # 92);   -- 0x5c
  END LOOP;
  RETURN pg_catalog.sha256(v_opad || pg_catalog.sha256(v_ipad || p_message));
END
$$;
--> statement-breakpoint

-- HMAC-SHA256(cursor_key, yük), ilk 128 bit (hex).
CREATE OR REPLACE FUNCTION public.app_api_cursor_mac(p_key text, p_payload text)
  RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.left(pg_catalog.encode(public.app_api_hmac_sha256(
           pg_catalog.convert_to(p_key, 'UTF8'), pg_catalog.convert_to(p_payload, 'UTF8')), 'hex'), 32)
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. İşlemcinin "değişti" satırlarına erişimi
-- ---------------------------------------------------------------------------
CREATE POLICY api_calendar_dirty_api_fn ON public.api_calendar_dirty FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.api_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.api_fn', true) = 'on');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. İşlemci
-- ---------------------------------------------------------------------------
-- Dönüş (tek satır): processed (işlenen villa), failed (hata veren villa), changes (yazılan kayıt),
-- discarded (etkin bağlantısı olmadığı için yalnız silinen villa), last_change_id.
CREATE FUNCTION public.app_api_process_changes(p_max_properties integer)
  RETURNS TABLE (processed integer, failed integer, changes integer, discarded integer,
                 last_change_id bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_max integer := LEAST(GREATEST(coalesce(p_max_properties, 50), 1), 500);
  v_today date;
  v_from date;
  v_to date;
  v_now timestamptz;
  v_prop uuid;
  v_n integer;
  v_processed integer := 0;
  v_failed integer := 0;
  v_changes integer := 0;
  v_discarded integer := 0;
  v_last bigint;
  v_state text;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);

  -- a) Kilit (ilk ifade): snapshot'lar ve diğer işlemci çağrıları bu transaction'la sıralanır.
  UPDATE public.api_sync_state s SET updated_at = pg_catalog.clock_timestamp() WHERE s.id = 1;

  v_now := pg_catalog.clock_timestamp();
  v_today := (v_now AT TIME ZONE 'Europe/Istanbul')::date;
  v_from := v_today - 366;
  v_to := v_today + 731;

  -- b) Sırası gelmiş villalar (en eski satıra göre).
  FOR v_prop IN
    SELECT d.property_id
      FROM public.api_calendar_dirty d
     WHERE d.next_attempt_at IS NULL OR d.next_attempt_at <= v_now
     GROUP BY d.property_id
     ORDER BY pg_catalog.min(d.id)
     LIMIT v_max
  LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM public.api_calendar_connections c
                  WHERE c.property_id = v_prop AND c.status = 'active') THEN
        -- c) TEK ifade: tüket + birleştir + kırp + güncel doluluk + yaz.
        WITH consumed AS (
          DELETE FROM public.api_calendar_dirty d
           WHERE d.property_id = v_prop
             AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= v_now)
          RETURNING d.start_date, d.end_date
        ), merged AS (
          SELECT pg_catalog.unnest(pg_catalog.range_agg(
                   pg_catalog.daterange(x.start_date, x.end_date, '[)')
                   * pg_catalog.daterange(v_from, v_to, '[)'))) AS b
            FROM consumed x
        ), written AS (
          INSERT INTO public.api_calendar_changes (property_id, start_date, end_date, busy)
          SELECT v_prop, pg_catalog.lower(m.b), pg_catalog.upper(m.b),
                 public.app_api_busy_json(v_prop, pg_catalog.lower(m.b), pg_catalog.upper(m.b))
            FROM merged m
           WHERE NOT pg_catalog.isempty(m.b)
           ORDER BY pg_catalog.lower(m.b)
          RETURNING 1
        )
        SELECT pg_catalog.count(*)::integer INTO v_n FROM written;
        v_changes := v_changes + v_n;
        v_processed := v_processed + 1;
      ELSE
        DELETE FROM public.api_calendar_dirty d
         WHERE d.property_id = v_prop
           AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= v_now);
        v_discarded := v_discarded + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- d) Yalnız bu villa geri alındı; satırlar korunur, yeniden deneme bilgisi yazılır.
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      UPDATE public.api_calendar_dirty d
         SET attempts = d.attempts + 1,
             next_attempt_at = v_now + LEAST(interval '10 seconds' * (2 ^ LEAST(d.attempts, 12)),
                                             interval '1 hour'),
             last_error = 'sqlstate_' || pg_catalog.lower(coalesce(v_state, 'xxxxx'))
       WHERE d.property_id = v_prop
         AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= v_now);
      v_failed := v_failed + 1;
    END;
  END LOOP;

  -- e) Son kimlik (aynı transaction, aynı kilit altında).
  UPDATE public.api_sync_state s
     SET last_change_id = GREATEST(s.last_change_id,
                                   coalesce((SELECT pg_catalog.max(c.id)
                                               FROM public.api_calendar_changes c), 0)),
         updated_at = pg_catalog.clock_timestamp()
   WHERE s.id = 1
  RETURNING s.last_change_id INTO v_last;

  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RETURN QUERY SELECT v_processed, v_failed, v_changes, v_discarded, v_last;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Saklama (31 gün; cursor ömrü 30 gün)
-- ---------------------------------------------------------------------------
-- Dönüş: silinen kayıt sayısı.
CREATE FUNCTION public.app_api_prune_changes()
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_max bigint;
  v_n integer;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  UPDATE public.api_sync_state s SET updated_at = pg_catalog.clock_timestamp() WHERE s.id = 1;
  WITH gone AS (
    DELETE FROM public.api_calendar_changes c
     WHERE c.created_at < pg_catalog.clock_timestamp() - interval '31 days'
    RETURNING c.id
  )
  SELECT pg_catalog.count(*)::integer, pg_catalog.max(g.id) INTO v_n, v_max FROM gone g;
  IF v_max IS NOT NULL THEN
    UPDATE public.api_sync_state s
       SET pruned_through_id = LEAST(GREATEST(s.pruned_through_id, v_max), s.last_change_id)
     WHERE s.id = 1;
  END IF;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RETURN v_n;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. EXECUTE yetkileri (işlemci süreci uygulamanın app_user bağlantısını kullanır)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_api_hmac_sha256(bytea, bytea),
  public.app_api_process_changes(integer),
  public.app_api_prune_changes() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_api_process_changes(integer),
  public.app_api_prune_changes() TO app_user;
