#!/usr/bin/env bash
# Mac → Hetzner geliştirme veritabanı SSH tüneli.
#   npm run db:tunnel          tüneli arka planda açar
#   npm run db:tunnel -- stop  tüneli kapatır
#   npm run db:tunnel -- status
# Postgres internete açılmaz: sunucuda yalnız 127.0.0.1:55432 dinler, bağlantı SSH içinden geçer.
# Production veritabanı için tünel YOKTUR (bilinçli olarak).
set -euo pipefail

cd "$(dirname "$0")/.."
PID_FILE=".db-tunnel.pid"

read_env() {
  # .env.local'den tek bir değişkeni okur (dosyayı source etmeden).
  local key="$1"
  [[ -f .env.local ]] || return 0
  grep -E "^${key}=" .env.local | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'
}

SSH_TARGET="${DB_TUNNEL_SSH:-$(read_env DB_TUNNEL_SSH)}"
LOCAL_PORT="${DB_TUNNEL_LOCAL_PORT:-$(read_env DB_TUNNEL_LOCAL_PORT)}"
REMOTE_PORT="${DB_TUNNEL_REMOTE_PORT:-$(read_env DB_TUNNEL_REMOTE_PORT)}"
LOCAL_PORT="${LOCAL_PORT:-5433}"
REMOTE_PORT="${REMOTE_PORT:-55432}"

is_running() { [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

case "${1:-start}" in
  stop)
    if is_running; then kill "$(cat "$PID_FILE")" && rm -f "$PID_FILE" && echo "Tünel kapatıldı."; else rm -f "$PID_FILE"; echo "Açık tünel yok."; fi
    exit 0 ;;
  status)
    if is_running; then echo "Tünel açık: localhost:${LOCAL_PORT} → sunucu 127.0.0.1:${REMOTE_PORT}"; else echo "Tünel kapalı."; fi
    exit 0 ;;
  start) ;;
  *) echo "Kullanım: db-tunnel.sh [start|stop|status]"; exit 2 ;;
esac

if [[ -z "$SSH_TARGET" || "$SSH_TARGET" == "kullanici@sunucu-adresi" ]]; then
  echo "DB_TUNNEL_SSH tanımlı değil. .env.local içine örn. DB_TUNNEL_SSH=burhan@1.2.3.4 ekleyin." >&2
  exit 1
fi
if is_running; then
  echo "Tünel zaten açık (localhost:${LOCAL_PORT})."
  exit 0
fi
if lsof -iTCP:"$LOCAL_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "localhost:${LOCAL_PORT} başka bir uygulama tarafından kullanılıyor." >&2
  exit 1
fi

ssh -N -f \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L "127.0.0.1:${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" \
  "$SSH_TARGET"

# ssh -f arka plana geçtiği için PID'i port üzerinden bul.
sleep 1
PID="$(lsof -tiTCP:"$LOCAL_PORT" -sTCP:LISTEN | head -n1 || true)"
if [[ -z "$PID" ]]; then
  echo "Tünel açılamadı." >&2
  exit 1
fi
echo "$PID" > "$PID_FILE"
echo "Tünel açık: localhost:${LOCAL_PORT} → sunucu 127.0.0.1:${REMOTE_PORT} (kapatmak: npm run db:tunnel -- stop)"
