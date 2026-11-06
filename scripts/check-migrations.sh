#!/usr/bin/env bash
# CI: uygulanmış migration dosyaları değiştirilemez veya silinemez; yalnız yeni dosya eklenebilir.
# Kullanım: scripts/check-migrations.sh <karşılaştırılacak-dal>   (örn. origin/develop)
set -euo pipefail
BASE="${1:?karşılaştırılacak dal gerekli}"

changed="$(git diff --name-status "$BASE"...HEAD -- drizzle/ | grep -E '^(M|D|R)' | grep -vE 'drizzle/meta/' || true)"
if [[ -n "$changed" ]]; then
  echo "HATA: Uygulanmış migration dosyaları değiştirilmiş veya silinmiş:" >&2
  echo "$changed" >&2
  echo "Yeni bir migration oluşturun (npm run db:generate)." >&2
  exit 1
fi

journal_removed="$(git diff "$BASE"...HEAD -- drizzle/meta/_journal.json | grep -E '^-\s+"tag"' || true)"
if [[ -n "$journal_removed" ]]; then
  echo "HATA: _journal.json'dan migration kaydı silinmiş:" >&2
  echo "$journal_removed" >&2
  exit 1
fi
echo "Migration dosyaları değişmemiş."
