#!/bin/sh
# Konteyner giriş noktası.
#
# RUN_MIGRATIONS_ON_START=true ise sunucudan ÖNCE migration'ları çalıştırır:
#   - MIGRATION_DATABASE_URL (app_migrator) yalnız bu adımda kullanılır.
#   - Migration başarısız olursa konteyner sıfırdan farklı kodla kapanır; sağlık kontrolü
#     geçmediği için Coolify yeni sürümü devreye almaz, eski sürüm çalışmaya devam eder.
#   - Aynı anda açılan konteynerler advisory lock ile sıraya girer (src/db/migrate.ts).
#
# Her durumda MIGRATION_DATABASE_URL, uygulama sürecine geçmeden ortamdan silinir:
# web sunucusu yalnız DATABASE_URL'i (app_user) görür.
set -eu

log() {
  # Uygulama log'larıyla aynı biçimde tek satır JSON.
  printf '{"time":"%s","level":"%s","msg":"%s","service":"entrypoint"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2"
}

case "${RUN_MIGRATIONS_ON_START:-false}" in
  true)
    if [ -z "${MIGRATION_DATABASE_URL:-}" ]; then
      log error "RUN_MIGRATIONS_ON_START=true ama MIGRATION_DATABASE_URL tanımlı değil"
      exit 1
    fi
    log info "migrations_on_start"
    if ! node dist/migrate.js; then
      log error "migration_failed_container_stopping"
      exit 1
    fi
    ;;
  false | "") ;;
  *)
    log error "RUN_MIGRATIONS_ON_START yalnız true veya false olabilir"
    exit 1
    ;;
esac

unset MIGRATION_DATABASE_URL
exec "$@"
