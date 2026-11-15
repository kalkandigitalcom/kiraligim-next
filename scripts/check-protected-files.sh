#!/usr/bin/env bash
# Opsiyon Aşama 3 — değiştirilemez kabul kriteri: mevcut çalışan sistemin dosyaları DEĞİŞMEZ.
# Kullanım: scripts/check-protected-files.sh <karşılaştırılacak-commit>   (örn. 88ae8c1)
# Çalışma ağacı (commit edilmemiş ve izlenmeyen dosyalar dahil) verilen commit ile karşılaştırılır;
# korunan bir dosya eklenmiş, değişmiş veya silinmişse çıkış kodu 1.
set -euo pipefail
BASE="${1:?karşılaştırılacak commit gerekli (örn. 88ae8c1)}"

PROTECTED=(
  # Ayrıştırıcı ve WhatsApp (worker, otomatik kapat / aç / değiştir, öneriler, tepki kararı)
  "src/lib/wa-calendar-parse.ts"
  "src/lib/whatsapp-meta.ts"
  "src/server/whatsapp"
  # Rezervasyon, iCal, API, webhook
  "src/server/reservations"
  "src/lib/reservation-meta.ts"
  "src/server/ical"
  "src/server/api"
  # WhatsApp ağ geçidi
  "services/wa-gateway"
  # Mevcut Super Admin WhatsApp ekranları ve işletme paneli WhatsApp yönlendirmesi
  "src/app/admin/(panel)/whatsapp"
  "src/server/admin/whatsapp.ts"
  # Görev komutları ve Docker
  "Dockerfile"
  "scripts/docker-entrypoint.sh"
  "scripts/wa-gateway-role.sql"
  "scripts/db-bootstrap.sql"
)

fail=0
changed="$(git diff --name-status "$BASE" -- "${PROTECTED[@]}" || true)"
untracked="$(git ls-files --others --exclude-standard -- "${PROTECTED[@]}" || true)"
if [[ -n "$changed" || -n "$untracked" ]]; then
  echo "HATA: korunan dosyalar değişmiş:" >&2
  [[ -n "$changed" ]] && echo "$changed" >&2
  [[ -n "$untracked" ]] && echo "$untracked" | sed 's/^/??\t/' >&2
  fail=1
fi

# Uygulanmış migration'lar (BASE'de var olan her drizzle/*.sql) değişmez ve silinmez.
applied="$(git ls-tree --name-only "$BASE" drizzle/ | grep -E '\.sql$' || true)"
mig="$(git diff --name-status "$BASE" -- $applied || true)"
if [[ -n "$mig" ]]; then
  echo "HATA: uygulanmış migration dosyaları değişmiş:" >&2
  echo "$mig" >&2
  fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "Korunan dosyalar ve uygulanmış migration'lar değişmemiş ($(echo "$applied" | wc -l | tr -d ' ') migration, ${#PROTECTED[@]} yol)."
fi
exit $fail
