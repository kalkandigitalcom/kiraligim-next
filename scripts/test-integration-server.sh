#!/usr/bin/env bash
# Entegrasyon testlerini Docker kurulu bir Linux sunucuda (ör. Hetzner) tamamen izole çalıştırır.
#
# - Coolify'a, Coolify ağlarına, mevcut konteynerlere ve veritabanlarına DOKUNMAZ.
# - Hiçbir port dışarı açılmaz (-p yok). Test konteyneri, Postgres konteynerinin ağ alanını
#   paylaşır; testler 127.0.0.1 üzerinden bağlanır.
# - İş bitince (hata olsa da) iki konteyner ve geçici klon silinir.
#
# Kullanım (sunucuda, normal kullanıcıyla):
#   curl -fsSL https://raw.githubusercontent.com/kalkandigitalcom/kiraligim-next/<dal>/scripts/test-integration-server.sh -o /tmp/kg-test.sh
#   bash /tmp/kg-test.sh [dal]          # varsayılan dal: develop
set -euo pipefail

REPO="${REPO:-https://github.com/kalkandigitalcom/kiraligim-next.git}"
BRANCH="${1:-develop}"
PG_IMAGE="${PG_IMAGE:-postgres:17-alpine}"
NODE_IMAGE="${NODE_IMAGE:-node:24-bookworm-slim}"
RUN_ID="kiraligim-it-$(date +%s)-$$"
WORKDIR="$(mktemp -d "/tmp/${RUN_ID}.XXXX")"
PG="${RUN_ID}-pg"

cleanup() {
  docker rm -f "$PG" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

command -v docker >/dev/null || { echo "docker bulunamadı" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker çalışmıyor veya bu kullanıcının yetkisi yok" >&2; exit 1; }

echo "→ Kod alınıyor: $REPO ($BRANCH)"
git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$WORKDIR/app"

echo "→ Geçici Postgres başlatılıyor (port açılmıyor)"
docker run -d --rm --name "$PG" \
  --label kiraligim.purpose=integration-test \
  --memory 512m --cpus 1 \
  -e POSTGRES_PASSWORD=postgres \
  "$PG_IMAGE" >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec "$PG" psql -U postgres -h 127.0.0.1 -tAc "select 1" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo "Postgres 60 saniyede hazır olmadı" >&2; exit 1; }

echo "→ Testler çalışıyor"
docker run --rm \
  --network "container:${PG}" \
  --memory 2g --cpus 2 \
  -v "$WORKDIR/app:/app" -w /app \
  -e CI=1 \
  -e NEXT_TELEMETRY_DISABLED=1 \
  -e TEST_ADMIN_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/postgres" \
  "$NODE_IMAGE" \
  bash -c "apt-get update -qq >/dev/null && apt-get install -y -qq postgresql-client >/dev/null \
    && npm ci --no-audit --no-fund \
    && npm run test:integration; status=\$?; chown -R $(id -u):$(id -g) /app; exit \$status"

echo "✓ Entegrasyon testleri başarılı. Geçici konteyner ve dosyalar siliniyor."
