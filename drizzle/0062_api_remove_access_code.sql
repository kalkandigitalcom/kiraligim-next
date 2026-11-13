-- Acente erişim kodu kaldırıldı; villa izinlerini yalnız Super Admin ekler ve kaldırır. İşletme
-- paneli izinleri yalnız görür.
--
-- Kaldırılanlar:
--   * app_api_lookup_access_code(text), app_api_grant_property(uuid, text, uuid) — ev sahibinin kodla
--     izin vermesi (işletme paneli).
--   * app_api_admin_set_access_code(uuid, uuid, text, text) — Super Admin'in kod üretmesi.
--   * app_api_revoke_property_grant(uuid) — işletme sahibi/yöneticisinin izni kaldırması. İzni artık
--     yalnız app_api_admin_revoke_grant kaldırır (bağlantıyı aynı şekilde 'revoked' ile bitirir).
--   * api_clients.access_code_hash / access_code_hint / access_code_created_at, ilgili benzersiz
--     indeks ve biçim kısıtı.
-- Değişen:
--   * app_api_admin_client(uuid, uuid) artık kod alanlarını döndürmez (dönüş tipi değiştiği için
--     DROP + CREATE; yetkiler 0052'deki gibi yeniden verilir).
--
-- Korunanlar: api_access_grants satırlarının HİÇBİRİ silinmez veya değiştirilmez; granted_via
-- ('owner' | 'admin') ve granted_by_user geçmiş kayıt olarak kalır, kodla verilmiş izinler
-- geçerliliğini korur; revoked_by_user gibi geçmiş alanlar kalır. app_api_property_grants ve
-- app_api_property_connections (işletme tarafında görüntüleme), app_api_admin_grant/revoke_grant,
-- app_api_end_grant_connections, anahtarlar, bağlantılar, değişiklik akışları ve webhook
-- fonksiyonları değişmez. API bağlantılarına dokunulmaz. Denetim kayıtları (api.access_code_created dahil)
-- silinmez.
--
-- Geri dönüş: kod özetleri veri olarak kaybolur (yalnız özet tutuluyordu; yeni kod üretilmesi
-- gerekir). Fonksiyonlar ve kolonlar gerekirse 0051/0052'deki tanımlarla yeniden oluşturulabilir.
-- Sıra: önce fonksiyonlar (kolonlara başvururlar), sonra kolonlar.

DROP FUNCTION public.app_api_lookup_access_code(text);
--> statement-breakpoint
DROP FUNCTION public.app_api_grant_property(uuid, text, uuid);
--> statement-breakpoint
DROP FUNCTION public.app_api_admin_set_access_code(uuid, uuid, text, text);
--> statement-breakpoint
DROP FUNCTION public.app_api_revoke_property_grant(uuid);
--> statement-breakpoint
DROP FUNCTION public.app_api_admin_client(uuid, uuid);
--> statement-breakpoint

CREATE FUNCTION public.app_api_admin_client(p_admin uuid, p_client uuid)
  RETURNS TABLE (id uuid, name text, status text, rate_limit_per_minute integer,
                 created_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  PERFORM public.app_api_admin_assert(p_admin);
  RETURN QUERY
    SELECT c.id, c.name, c.status, c.rate_limit_per_minute, c.created_at
      FROM public.api_clients c WHERE c.id = p_client;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_api_admin_client(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_api_admin_client(uuid, uuid) TO app_admin;
--> statement-breakpoint
ALTER TABLE "api_clients" DROP CONSTRAINT "api_clients_access_code_format";--> statement-breakpoint
DROP INDEX "api_clients_access_code_hash_key";--> statement-breakpoint
ALTER TABLE "api_clients" DROP COLUMN "access_code_hash";--> statement-breakpoint
ALTER TABLE "api_clients" DROP COLUMN "access_code_hint";--> statement-breakpoint
ALTER TABLE "api_clients" DROP COLUMN "access_code_created_at";
