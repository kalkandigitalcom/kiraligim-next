-- Migration 0063 (reservations_whatsapp_not_pending) için production ön kontrolü. SALT OKUMA.
--
-- Ne zaman: 0063'ü içeren sürüm deploy edilmeden hemen önce. Uygulama açılışta migration'ları
-- kendisi çalıştırır (RUN_MIGRATIONS_ON_START=true); 0063 başarısız olursa yeni sürüm AÇILMAZ.
-- Bu yüzden 'whatsapp_pending' 0 değilse deploy edilmez; kayıtlar önce panelde incelenir.
--
-- Nerede: Coolify → kiraligim-postgres-prod → Terminal → Connect (PostgreSQL konteyneri).
-- Konteynerde repo dosyası yoktur; sorgu aşağıdaki komutların içinde (gzip + base64) taşınır.
-- Taşınan metin, bu dosyanın "BEGIN TRANSACTION READ ONLY;" satırından sonuna kadar olan
-- bölümün AYNISIDIR (tests/unit/precheck-0063.test.ts bunu doğrular; sorgu değişirse komutlar
-- `sed -n '/^BEGIN TRANSACTION READ ONLY;/,$p' docs/precheck-0063.sql | gzip -9cn | base64 -w0`
-- ile yeniden üretilir).
--
-- Salt okuma güvenceleri: oturum default_transaction_read_only=on ile açılır, sorgu
-- BEGIN TRANSACTION READ ONLY … ROLLBACK içindedir, yalnız SELECT vardır, konteynere dosya
-- yazılmaz. Çıktı yalnız sayıdır; misafir adı, telefon veya mesaj metni okunmaz.
-- RLS'i atlayan veritabanı sahibi rolü ($POSTGRES_USER) kullanılır; app_migrator / app_user
-- FORCE RLS nedeniyle satırları göremez ve yanlışlıkla 0 döndürür ('rls_atlar' true olmalı).
--
-- 1) (İsteğe bağlı) Çalıştırmadan önce taşınan sorguyu görüntüle — tek satır, olduğu gibi yapıştır:
--
-- echo 'H4sIAAAAAAACA4VTTY/aMBC98yvmlqRiEatKPbDqIbDpFpWSKlBt92RNgpV64ziRP1hBtb+FY8/5DQ3/qw6BdGkX1Sd7PPNm3vPzOLibzmEZ+fOFP1lOwzlEgX8L4Xz2cNPrLYJZMFnCoyoEiQ3jK1LEjzTRbg/AyQznKFjCnD4kRkoqNDGKyn5zKbkiqDlKe+keYWTBlSmphDBq9vGmRKVsInyIws9QpsQGqYL7j0EUNAkCcwrvz7C9BvzqCoZQ8Bx5XQ3sdkXrHeOKQs5SiZoVAmLc71DWlaqrrU01EtYUzCY1HHME/PWzrmz9dtCM+vQdtcKyJCUVKybSFxMnhRHafeMdJzQxZ8lAUjvI+tBH2frXV0tCFUYmDYeuiQP+/BaURm1UEz/1PBEbM56yEWRGIocNctEQuG+K/bKEDDcC611d2bA9lArlDTzRGDRyWnIqWcOTck4hZZLtdzYEVGeMU5HTlu6xIzlgZWdkLYhKqHt47vahCaapm/VBeH1wfjw7o1FzedTDvcT+b8BWBovgxoXyHA/8BVjQTl17FBeVvKj9SeN/tIS7KPz6BcYPcO2BelXZLWoqYI1SIbh/bNM6ROR1td95oKWhg9bptoasD2YOvk0Xy0Un2nVn3sSOpCUyof9jCpt4dLbzkg7pfCgKTc584XQTEoUbpthFi64k2245HRDSlSivd1DYFmeF0PZfkeHw3Vv7u6NwNhv7k083vd+t8nM0BgQAAA==' | base64 -d | gunzip
--
-- 2) Ön kontrolü çalıştır — tek satır, olduğu gibi yapıştır:
--
-- echo 'H4sIAAAAAAACA4VTTY/aMBC98yvmlqRiEatKPbDqIbDpFpWSKlBt92RNgpV64ziRP1hBtb+FY8/5DQ3/qw6BdGkX1Sd7PPNm3vPzOLibzmEZ+fOFP1lOwzlEgX8L4Xz2cNPrLYJZMFnCoyoEiQ3jK1LEjzTRbg/AyQznKFjCnD4kRkoqNDGKyn5zKbkiqDlKe+keYWTBlSmphDBq9vGmRKVsInyIws9QpsQGqYL7j0EUNAkCcwrvz7C9BvzqCoZQ8Bx5XQ3sdkXrHeOKQs5SiZoVAmLc71DWlaqrrU01EtYUzCY1HHME/PWzrmz9dtCM+vQdtcKyJCUVKybSFxMnhRHafeMdJzQxZ8lAUjvI+tBH2frXV0tCFUYmDYeuiQP+/BaURm1UEz/1PBEbM56yEWRGIocNctEQuG+K/bKEDDcC611d2bA9lArlDTzRGDRyWnIqWcOTck4hZZLtdzYEVGeMU5HTlu6xIzlgZWdkLYhKqHt47vahCaapm/VBeH1wfjw7o1FzedTDvcT+b8BWBovgxoXyHA/8BVjQTl17FBeVvKj9SeN/tIS7KPz6BcYPcO2BelXZLWoqYI1SIbh/bNM6ROR1td95oKWhg9bptoasD2YOvk0Xy0Un2nVn3sSOpCUyof9jCpt4dLbzkg7pfCgKTc584XQTEoUbpthFi64k2245HRDSlSivd1DYFmeF0PZfkeHw3Vv7u6NwNhv7k083vd+t8nM0BgQAAA==' | base64 -d | gunzip | PGOPTIONS='-c default_transaction_read_only=on' psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -f -
--
-- Beklenen çıktı: BEGIN, tek satır JSON ({"kullanici" : "postgres", "rls_atlar" : true,
-- "whatsapp_pending" : 0, …}) ve ROLLBACK. Deploy için 'whatsapp_pending' 0 olmalıdır.
-- 'kural_var' deploy öncesi false, deploy sonrası true olur.

BEGIN TRANSACTION READ ONLY;

SELECT json_build_object(
  'kullanici', current_user,
  'rls_atlar', (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user),
  -- 0 olmalı. 0 değilse migration başarısız olur ve uygulama açılmaz.
  'whatsapp_pending', (SELECT count(*) FROM public.reservations
                        WHERE source = 'whatsapp' AND status = 'pending'),
  -- Bilgi: kural yalnız WhatsApp kaynağını kapsar; web talepleri ve elle girişler etkilenmez.
  'pending_kaynak', (SELECT coalesce(json_object_agg(k, n), '{}'::json) FROM (
                       SELECT coalesce(source, '(bos)') AS k, count(*) AS n
                         FROM public.reservations WHERE status = 'pending' GROUP BY 1) s),
  -- Bilgi: kural zaten varsa (migration uygulanmış) true.
  'kural_var', EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conname = 'reservations_whatsapp_not_pending'),
  'migration_sayisi', (SELECT count(*) FROM drizzle.__migrations)
) AS on_kontrol_0063;

ROLLBACK;
