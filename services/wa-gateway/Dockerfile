# syntax=docker/dockerfile:1.7
# Kiraligim WhatsApp ağ geçidi (A1) imajı. Derleme bağlamı: services/wa-gateway (Coolify "Base Directory").
# İmaj hiçbir sır ve oturum anahtarı içermez (.dockerignore); değerler çalışma zamanında verilir.
# Oturum anahtarları kalıcı volume'da: /app/.wa-auth (Coolify → Persistent Storage → Volume Mount).

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# tsx çalışma zamanında gerekir (TypeScript doğrudan çalıştırılır); geliştirme bağımlılıkları dahil.
RUN npm ci --include=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    WA_HTTP_HOST=0.0.0.0 \
    WA_HTTP_PORT=4010 \
    WA_REQUIRE_DATABASE=true

RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app --no-create-home app

COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json tsconfig.json ./
COPY --chown=root:root src ./src
# Kod root'a ait ve salt okunur; yalnız kilit dosyası (/app/.wa-auth.lock) ve oturum klasörü
# uygulama kullanıcısına yazılabilir. Adlandırılmış volume ilk bağlanışta bu sahipliği devralır.
RUN mkdir -m 0700 /app/.wa-auth && chown app:app /app /app/.wa-auth

USER app
EXPOSE 4010

# Süreç ve yerel arayüz ayakta mı (oturum durdurulduysa 503). Konteyner içinden 127.0.0.1'e gider.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4010/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# npm üzerinden değil: SIGTERM doğrudan Node'a gelsin (düzgün kapanma, kilit temizliği).
CMD ["node", "--import", "tsx", "src/main.ts"]
