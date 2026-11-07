-- 0020_property_rates_cleaning_fee (Aşama 3.3)
-- Fiyat dönemine isteğe bağlı temizlik ücreti ve ücretsiz temizlik gece sınırı. Kolonlar NULL
-- eklenir (varsayılan yok, tablo yeniden yazılmaz); mevcut dönemler "ücret yok" olarak kalır ve
-- CHECK kısıtlarını karşılar. Yetkiler 0021'de.
-- Geri alma: ALTER TABLE public.property_rates DROP COLUMN cleaning_fee_free_nights,
--                                          DROP COLUMN cleaning_fee_minor;
ALTER TABLE "property_rates" ADD COLUMN "cleaning_fee_minor" bigint;--> statement-breakpoint
ALTER TABLE "property_rates" ADD COLUMN "cleaning_fee_free_nights" smallint;--> statement-breakpoint
ALTER TABLE "property_rates" ADD CONSTRAINT "property_rates_cleaning_fee" CHECK ("property_rates"."cleaning_fee_minor" is null or "property_rates"."cleaning_fee_minor" between 0 and 999999999999);--> statement-breakpoint
ALTER TABLE "property_rates" ADD CONSTRAINT "property_rates_cleaning_fee_free_nights" CHECK ("property_rates"."cleaning_fee_free_nights" is null or ("property_rates"."cleaning_fee_free_nights" between 1 and 365 and "property_rates"."cleaning_fee_minor" is not null));