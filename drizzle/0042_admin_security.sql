-- 0042_admin_security (Super Admin minimal — Aşama 2.8: yetkiler ve RLS)
--
-- admin_* tabloları YALNIZ app_admin rolüne açıktır (DATABASE_ADMIN_URL; LOGIN ve parola
-- scripts/admin-role.sql ile bir kez verilir). app_user, app_worker, app_wa_gateway ve PUBLIC'in
-- hiçbir yetkisi yoktur: işletme paneli (app_user) ele geçirilse bile yönetici hesaplarına,
-- oturumlarına ve denetim kaydına erişemez. app_admin işletme tablolarına bu migration ile hiçbir
-- yetki ALMAZ (WhatsApp grup yönetimi ileride dar SECURITY DEFINER fonksiyonlarla).
--
-- Ek savunma: ENABLE + FORCE RLS; politika yalnız app_admin için. Denetim kaydı yalnız eklenir
-- (UPDATE/DELETE yetkisi yok). Yönetici hesabı silinmez (DELETE yok; devre dışı bırakılır).
--
-- Geri alma: DROP TABLE admin_sessions, admin_login_challenges, admin_audit_log, admin_users (0041).

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.admin_users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.admin_login_challenges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.admin_login_challenges FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.admin_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.admin_sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.admin_audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY admin_users_admin ON public.admin_users FOR ALL TO app_admin USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY admin_login_challenges_admin ON public.admin_login_challenges FOR ALL TO app_admin
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY admin_sessions_admin ON public.admin_sessions FOR ALL TO app_admin USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY admin_audit_log_admin_read ON public.admin_audit_log FOR SELECT TO app_admin USING (true);
--> statement-breakpoint
CREATE POLICY admin_audit_log_admin_insert ON public.admin_audit_log FOR INSERT TO app_admin
  WITH CHECK (true);
--> statement-breakpoint

REVOKE ALL ON TABLE public.admin_users, public.admin_login_challenges, public.admin_sessions,
  public.admin_audit_log FROM PUBLIC, app_user, app_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.admin_users TO app_admin;
--> statement-breakpoint
GRANT UPDATE (name, password_hash, totp_secret_enc, totp_last_step, status, failed_count,
  locked_until, last_login_at, updated_at) ON TABLE public.admin_users TO app_admin;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE public.admin_login_challenges TO app_admin;
--> statement-breakpoint
GRANT UPDATE (attempts) ON TABLE public.admin_login_challenges TO app_admin;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE public.admin_sessions TO app_admin;
--> statement-breakpoint
GRANT UPDATE (last_seen_at, revoked_at) ON TABLE public.admin_sessions TO app_admin;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.admin_audit_log TO app_admin;
--> statement-breakpoint
-- Ağ geçidi rolü varsa (production) ona da hiçbir yetki yoktur (savunma; yeni tabloda zaten yok).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_wa_gateway') THEN
    REVOKE ALL ON TABLE public.admin_users, public.admin_login_challenges, public.admin_sessions,
      public.admin_audit_log FROM app_wa_gateway;
  END IF;
END
$$;
