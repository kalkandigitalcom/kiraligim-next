-- Aşama 0: WhatsApp kaynaklı rezervasyon beklemede (pending) olamaz.
-- Beklemede kayıt merkezi takvimde, iCal export'unda ve API'de dolu görünür; WhatsApp opsiyonları
-- ayrı modelde izlenecektir. Web talepleri (source = 'web') ve paneldeki elle girişler etkilenmez.
-- Uygulamadan önce (salt okuma) 0 dönmelidir:
--   SELECT count(*) FROM public.reservations WHERE source = 'whatsapp' AND status = 'pending';
-- Geri alma: ALTER TABLE "reservations" DROP CONSTRAINT "reservations_whatsapp_not_pending";
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_whatsapp_not_pending" CHECK ("reservations"."source" is distinct from 'whatsapp' or "reservations"."status" <> 'pending');
