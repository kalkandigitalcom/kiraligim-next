-- 0018_property_rates_security
-- property_rates (0017) için: çakışma kısıtı, RLS (ENABLE + FORCE), politikalar, kolon düzeyinde
-- yetkiler ve updated_at tetikleyicisi. 0017 ile aynı deploy'da uygulanır.
--
-- Kararlar (Aşama 3.1):
--   * Dönem [start_date, end_date) yarı açık aralıktır (rezervasyonlarla aynı); bitişik dönemler
--     serbesttir, aynı mülkte kesişen dönem olamaz.
--   * Owner ve manager fiyat dönemi ekler, düzenler ve siler; staff yalnız görüntüler.
--   * Mülk, işletme ve oluşturan sonradan değiştirilemez (UPDATE yetkisi verilmez).
--   * Fiyat dönemleri rezervasyon çakışma kısıtından bağımsızdır; rezervasyon tutarları buradan
--     hesaplanmaz ve mevcut rezervasyonlar etkilenmez.
--   * Yeni fonksiyon yok: updated_at için mevcut app_set_updated_at kullanılır.
--
-- Geri alma (yalnız tablo eklendiği için güvenlidir; başka tablo değişmez):
--   DROP TABLE public.property_rates;   -- politikalar, kısıt, tetikleyici ve yetkiler birlikte gider
-- Ayrıntı: docs/deployment.md → "3.1 fiyat dönemleri: geri alma".

-- ---------------------------------------------------------------------------
-- 1. Çakışma kısıtı (btree_gist: 0000_bootstrap'ta kurulu)
-- ---------------------------------------------------------------------------
-- Dizin düzeyinde denetlendiği için her izolasyon seviyesinde ve RLS'ten bağımsız çalışır:
-- aynı mülkte eşzamanlı iki kesişen eklemenin en fazla biri commit edilebilir.
ALTER TABLE public.property_rates ADD CONSTRAINT property_rates_no_overlap
  EXCLUDE USING gist (property_id WITH =, daterange(start_date, end_date, '[)') WITH &&);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. RLS (ENABLE + FORCE)
-- ---------------------------------------------------------------------------
ALTER TABLE public.property_rates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.property_rates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Okuma: bağlamdaki AKTİF işletmenin tüm üyeleri (staff dahil). Askıdaki işletmede rol NULL.
CREATE POLICY property_rates_select ON public.property_rates FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY property_rates_insert ON public.property_rates FOR INSERT TO app_user
  WITH CHECK (workspace_id = public.app_current_workspace_id()
              AND public.app_current_member_role() IN ('owner', 'manager')
              AND created_by = public.app_current_user_id());
--> statement-breakpoint
CREATE POLICY property_rates_update ON public.property_rates FOR UPDATE TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'))
  WITH CHECK (workspace_id = public.app_current_workspace_id());
--> statement-breakpoint
CREATE POLICY property_rates_delete ON public.property_rates FOR DELETE TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Yetkiler (kolon düzeyinde; PUBLIC / app_admin / app_worker: hiçbiri)
-- ---------------------------------------------------------------------------
GRANT SELECT, DELETE ON TABLE public.property_rates TO app_user;
--> statement-breakpoint
GRANT INSERT (id, workspace_id, property_id, start_date, end_date, nightly_amount_minor,
              weekly_amount_minor, currency, min_nights, created_by)
  ON TABLE public.property_rates TO app_user;
--> statement-breakpoint
-- id, workspace_id, property_id, created_by, created_at: değişmez.
GRANT UPDATE (start_date, end_date, nightly_amount_minor, weekly_amount_minor, currency, min_nights)
  ON TABLE public.property_rates TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Tetikleyici
-- ---------------------------------------------------------------------------
CREATE TRIGGER property_rates_set_updated_at BEFORE UPDATE ON public.property_rates
  FOR EACH ROW EXECUTE FUNCTION public.app_set_updated_at();
