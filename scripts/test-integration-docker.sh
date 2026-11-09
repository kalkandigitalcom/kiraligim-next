#!/usr/bin/env bash
# Mac'te entegrasyon testleri: geçici bir Postgres 17 konteyneri açar, testleri koşturur, siler.
# Kalıcı veri tutmaz; geliştirme/production veritabanına dokunmaz. Docker Desktop gerekir.
set -euo pipefail

NAME="kiraligim-test-pg-$$"
PORT="${TEST_PG_PORT:-55439}"

if ! docker info >/dev/null 2>&1; then
  echo "Docker çalışmıyor. Docker Desktop'ı açıp tekrar deneyin." >&2
  exit 1
fi

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$NAME" \
  -e POSTGRES_PASSWORD=postgres \
  -p "127.0.0.1:${PORT}:5432" \
  postgres:17-alpine >/dev/null

echo "Geçici Postgres başlatılıyor..."
# İmaj ilk açılışta geçici bir sunucu başlatıp yeniden başlar; TCP üzerinden sorgu gelene kadar bekle.
ready=0
for _ in $(seq 1 60); do
  if docker exec "$NAME" psql -U postgres -h 127.0.0.1 -tAc "select 1" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  echo "Geçici Postgres 60 saniyede hazır olmadı." >&2
  exit 1
fi

export TEST_ADMIN_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${PORT}/postgres"
# db-bootstrap.sql konteynerin içindeki psql ile çalıştırılır (Mac'e psql kurmak gerekmez).
export PSQL_CMD="docker exec -i -e KG_MIGRATOR_PASSWORD -e KG_APP_PASSWORD -e KG_WA_GATEWAY_PASSWORD $NAME psql"
export PSQL_URL="postgres://postgres:postgres@localhost:5432/postgres"

npx vitest run --project integration
