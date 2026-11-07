-- 0019_property_rates_currency
-- Aşama 3.2: bir mülkün tüm fiyat dönemleri TEK para biriminde olur (konaklama fiyatı dönemlere
-- yayılarak hesaplandığı için). İlk dönemin para birimi mülkün para birimidir; farklı para
-- birimiyle yeni dönem eklenemez, mevcut dönem başka para birimine çekilemez (mülkün tek dönemi
-- ise değiştirilebilir). Yalnız property_rates'e tetikleyici eklenir; başka tablo ve veri değişmez.
--
-- Eşzamanlılık: mülk başına advisory lock (anahtar uzayı 7004) alındıktan SONRA diğer dönemlere
-- bakılır. READ COMMITTED'da her sorgu yeni anlık görüntü alır, kilidi bekleyen işlem önce commit
-- edilen dönemi görür; SERIALIZABLE çakışmayı kendisi yakalar. REPEATABLE READ'de anlık görüntü
-- kilitten önce alındığı için kural garanti edilemez: o seviyede yazma reddedilir (0010 ile aynı).
--
-- Geri alma: DROP TRIGGER property_rates_currency_guard ON public.property_rates;
--            DROP FUNCTION public.app_property_rates_currency_guard();

-- Mevcut veri: 0017–0019 aynı sürümde deploy edilir (production'da tablo boş başlar). Migration rolü
-- FORCE RLS nedeniyle satırları göremediği için burada veri ön denetimi yapılamaz; 3.1 tek başına
-- deploy edilip karışık para birimi girildiyse önce düzeltilmelidir (docs/deployment.md).
CREATE FUNCTION public.app_property_rates_currency_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_other text;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') NOT IN ('read committed', 'serializable') THEN
    RAISE EXCEPTION 'property_rates_currency_isolation'
      USING ERRCODE = 'invalid_transaction_state',
            DETAIL = 'Fiyat dönemi yalnız READ COMMITTED veya SERIALIZABLE transaction içinde yazılabilir.';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.property_id::text, 7004));

  SELECT r.currency INTO v_other
    FROM public.property_rates r
   WHERE r.property_id = NEW.property_id
     AND r.id <> NEW.id
     AND r.currency <> NEW.currency
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'property_rates_currency_mismatch'
      USING ERRCODE = 'check_violation',
            DETAIL = 'Bu mülkün fiyat dönemleri ' || v_other || ' para biriminde; tüm dönemler aynı para biriminde olmalı.';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_property_rates_currency_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER property_rates_currency_guard BEFORE INSERT OR UPDATE OF currency ON public.property_rates
  FOR EACH ROW EXECUTE FUNCTION public.app_property_rates_currency_guard();
