-- 0022_property_public_profile (Aşama F1: müşteriye açık villa sayfası altyapısı)
-- Mülke public sayfa alanları (adres, yayın isteği, olanaklar, giriş/çıkış saati, kurallar, iptal
-- ve ödeme koşulları) ve işletmeye WhatsApp iletişim numarası. Mevcut kayıtlar etkilenmez: yeni
-- kolonlar NULL ya da sabit varsayılanlıdır (false / boş dizi; PostgreSQL 11+ tabloyu yeniden
-- yazmaz); tüm mülkler taslak olarak başlar ve yeni CHECK kısıtlarını karşılar. Sayfa adresi
-- tüm işletmeler arasında benzersizdir (NULL'lar serbest). RLS politikaları değişmez; yalnız
-- UPDATE yetkileri 0023'te verilir.
-- Geri alma: DROP INDEX properties_public_slug_key; ALTER TABLE public.properties DROP COLUMN
--   public_slug, is_public, public_published_at, amenities, check_in_time, check_out_time,
--   house_rules, cancellation_policy, payment_terms; ALTER TABLE public.workspaces DROP COLUMN
--   contact_whatsapp;
ALTER TABLE "properties" ADD COLUMN "public_slug" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "public_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "amenities" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "check_in_time" time;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "check_out_time" time;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "house_rules" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "cancellation_policy" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "payment_terms" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "contact_whatsapp" text;--> statement-breakpoint
CREATE UNIQUE INDEX "properties_public_slug_key" ON "properties" USING btree ("public_slug");--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_public_slug_format" CHECK ("properties"."public_slug" is null or ("properties"."public_slug" ~ '^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$' and position('--' in "properties"."public_slug") = 0 and "properties"."public_slug" <> all (array['admin', 'api', 'app', 'www', 'villa', 'villalar', 'giris', 'kayit', 'cikis', 'panel', 'yeni', 'duzenle', 'onizleme', 'rezervasyon', 'rezervasyonlar', 'talep', 'talepler', 'takvim', 'fiyat', 'fiyatlar', 'iletisim', 'kvkk', 'gizlilik', 'kullanim-kosullari', 'cerez', 'cerezler', 'hakkimizda', 'sss', 'yardim', 'destek', 'blog', 'rehber', 'kiraligim', 'robots', 'sitemap', 'static', 'medya', 'test', 'demo', 'ornek', 'null', 'undefined'])));--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_public_requires_slug" CHECK (not "properties"."is_public" or ("properties"."public_slug" is not null and "properties"."public_published_at" is not null));--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_amenities" CHECK (cardinality("properties"."amenities") <= 40 and array_position("properties"."amenities", null) is null and (cardinality("properties"."amenities") = 0 or array_to_string("properties"."amenities", ',') ~ '^[a-z][a-z0-9-]{1,31}(,[a-z][a-z0-9-]{1,31})*$'));--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_stay_times" CHECK (("properties"."check_in_time" is null or extract(second from "properties"."check_in_time") = 0) and ("properties"."check_out_time" is null or extract(second from "properties"."check_out_time") = 0));--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_public_texts" CHECK (("properties"."house_rules" is null or (length("properties"."house_rules") between 1 and 2000 and "properties"."house_rules" !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')) and ("properties"."cancellation_policy" is null or (length("properties"."cancellation_policy") between 1 and 2000 and "properties"."cancellation_policy" !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')) and ("properties"."payment_terms" is null or (length("properties"."payment_terms") between 1 and 1000 and "properties"."payment_terms" !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_contact_whatsapp_format" CHECK ("workspaces"."contact_whatsapp" is null or "workspaces"."contact_whatsapp" ~ '^\+[1-9][0-9]{9,14}$');