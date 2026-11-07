-- 0014_property_details_grants
-- 0013'te eklenen mülk alanları için kolon düzeyinde yetkiler (0010 ile aynı model).
-- RLS politikaları (0010) değişmez: ekleme/düzenleme yalnız owner/manager, bağlamdaki işletme.
-- Mevcut kayıtlar etkilenmez: yeni kolonlar NULL veya varsayılan (false / boş dizi) değerlidir;
-- eski düz metin açıklamalar "description" kolonunda aynen kalır.
GRANT INSERT (description_html, tourism_license_no, youtube_video_ids,
              pool_swimming, pool_swimming_depth, pool_swimming_width, pool_swimming_length,
              pool_swimming_protected,
              pool_indoor, pool_indoor_depth, pool_indoor_width, pool_indoor_length,
              pool_kids, pool_kids_depth, pool_kids_width, pool_kids_length)
  ON TABLE public.properties TO app_user;
--> statement-breakpoint
GRANT UPDATE (description_html, tourism_license_no, youtube_video_ids,
              pool_swimming, pool_swimming_depth, pool_swimming_width, pool_swimming_length,
              pool_swimming_protected,
              pool_indoor, pool_indoor_depth, pool_indoor_width, pool_indoor_length,
              pool_kids, pool_kids_depth, pool_kids_width, pool_kids_length)
  ON TABLE public.properties TO app_user;
