-- 0021_property_rates_cleaning_fee_grants
-- 0020'de eklenen temizlik ücreti kolonları için kolon düzeyinde yetkiler (0018 ile aynı model:
-- yalnız app_user; RLS politikaları owner/manager yazmasını zaten sınırlar, staff yalnız okur).
-- Geri alma: REVOKE INSERT (cleaning_fee_minor, cleaning_fee_free_nights),
--                   UPDATE (cleaning_fee_minor, cleaning_fee_free_nights)
--              ON TABLE public.property_rates FROM app_user;
GRANT INSERT (cleaning_fee_minor, cleaning_fee_free_nights)
  ON TABLE public.property_rates TO app_user;
--> statement-breakpoint
GRANT UPDATE (cleaning_fee_minor, cleaning_fee_free_nights)
  ON TABLE public.property_rates TO app_user;
