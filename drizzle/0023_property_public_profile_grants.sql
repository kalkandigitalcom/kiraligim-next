-- 0023_property_public_profile_grants (Aşama F1)
-- 0022'de eklenen kolonlar için kolon düzeyinde yetkiler. Yalnız UPDATE: yeni mülk bu alanları
-- yazmaz (varsayılanlar yeterli). RLS politikaları değişmez:
--   * properties_update → yalnız owner/manager, yalnız bağlamdaki işletme (staff yazamaz);
--   * workspaces_update → yalnız owner (WhatsApp numarasını yönetici değiştiremez).
-- Geri alma: REVOKE UPDATE (public_slug, is_public, public_published_at, amenities, check_in_time,
--   check_out_time, house_rules, cancellation_policy, payment_terms) ON TABLE public.properties
--   FROM app_user; REVOKE UPDATE (contact_whatsapp) ON TABLE public.workspaces FROM app_user;
GRANT UPDATE (public_slug, is_public, public_published_at, amenities, check_in_time,
              check_out_time, house_rules, cancellation_policy, payment_terms)
  ON TABLE public.properties TO app_user;
--> statement-breakpoint
GRANT UPDATE (contact_whatsapp) ON TABLE public.workspaces TO app_user;
