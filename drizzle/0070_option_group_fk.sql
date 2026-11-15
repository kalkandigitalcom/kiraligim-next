-- 0070_option_group_fk (Opsiyon: A2 grup yabancı anahtarı düzeltmesi — yalnız iki opsiyon tablosu)
--
-- Sorun: reservation_options ve wa_option_shadow_decisions grubu (group_id, workspace_id) bileşik
-- anahtarıyla bağlıyordu. Super Admin "bağlantıyı kaldır" (app_wa_admin_unlink_group) grubun
-- workspace_id'sini NULL yapar; grupta opsiyon veya gölge kaydı varsa bu güncelleme 23503 ile
-- reddediliyor ve MEVCUT bağlantı kaldırma işlemi çalışmıyordu (production'da kayıt yoktu: etki yok).
--
-- Düzeltme: iki anahtar yalnız grup kimliğine bağlanır (wa_groups(id), ON DELETE restrict —
-- önceki silme davranışı aynı). Opsiyonun ve gölge kaydının işletmesi kendi workspace_id
-- sütununda kalır ve değişmez; fonksiyonlar grup ile işletmenin eşleşmesini zaten kendileri denetler.
-- Mevcut tablolara, fonksiyonlara ve WhatsApp / rezervasyon akışına DOKUNULMAZ.
--
-- Geri alma: docs/rollback-0070.sql.
ALTER TABLE "reservation_options" DROP CONSTRAINT "reservation_options_group_fk";
--> statement-breakpoint
ALTER TABLE "wa_option_shadow_decisions" DROP CONSTRAINT "wa_option_shadow_decisions_group_fk";
--> statement-breakpoint
ALTER TABLE "reservation_options" ADD CONSTRAINT "reservation_options_group_fk" FOREIGN KEY ("group_id") REFERENCES "public"."wa_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_option_shadow_decisions" ADD CONSTRAINT "wa_option_shadow_decisions_group_fk" FOREIGN KEY ("group_id") REFERENCES "public"."wa_groups"("id") ON DELETE restrict ON UPDATE no action;