/**
 * Depolama bağlantı denetimi: `npm run storage:check`
 * (Mac: .env.local; sunucu/konteyner: `node dist/storage-check.js`).
 *
 * 1. Yapılandırmayı doğrular (yalnız değişken adları raporlanır).
 * 2. Küçük bir metin nesnesi yazar: healthcheck/storage-check-<rastgele>.txt
 * 3. Nesneyi HERKESE AÇIK adresten (CDN alan adı) okur ve içeriği karşılaştırır.
 * 4. Nesneyi siler.
 * Anahtarlar, imzalar ve yanıt gövdeleri yazdırılmaz. Başarısızlıkta çıkış kodu 1.
 */
import { randomUUID } from "node:crypto";

import { parseStorageConfig } from "./env";
import { createFilesystemStorage } from "./filesystem";
import { createR2Storage } from "./r2";
import type { ObjectStorage } from "./types";

const out = (msg: string) => process.stdout.write(`${msg}\n`);

async function main(): Promise<number> {
  const result = parseStorageConfig(process.env);
  if (!result.ok) {
    out(`✗ Depolama yapılandırılmamış (sürücü: ${result.driver ?? "?"}):`);
    for (const issue of result.issues) out(`  - ${issue}`);
    return 1;
  }
  const c = result.config;
  if (c.driver === "memory") {
    out("✗ memory sürücüsü yalnız testler içindir; denetlenecek bir şey yok.");
    return 1;
  }
  let storage: ObjectStorage;
  if (c.driver === "r2") {
    out(`• Sürücü: r2 · bucket: ${c.r2.bucket} · CDN: ${new URL(c.r2.publicBaseUrl).host}`);
    storage = createR2Storage(c.r2);
  } else {
    out(`• Sürücü: filesystem · dizin: ${c.localDir} (yalnız yerel geliştirme)`);
    storage = createFilesystemStorage(c.localDir);
  }

  const key = `healthcheck/storage-check-${randomUUID()}.txt`;
  const body = new TextEncoder().encode(`kiraligim storage check ${new Date().toISOString()}\n`);
  let ok = true;
  try {
    await storage.put(key, body, {
      contentType: "text/plain; charset=utf-8",
      cacheControl: "no-store",
    });
    out("✓ Yazma (PUT) başarılı");
  } catch (err) {
    out(`✗ Yazma başarısız: ${err instanceof Error ? err.message : "bilinmeyen hata"}`);
    out(
      "  Kontrol: hesap kimliği, bucket adı, API belirtecinin bu bucket için 'Object Read & Write' yetkisi.",
    );
    return 1;
  }

  if (c.driver === "r2") {
    const url = storage.publicUrl(key);
    let status = 0;
    let same = false;
    for (let attempt = 0; attempt < 5 && !same; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
        status = res.status;
        same = res.ok && Buffer.from(await res.arrayBuffer()).equals(Buffer.from(body));
      } catch {
        status = 0;
      }
    }
    if (same) out(`✓ Herkese açık okuma başarılı (${new URL(url).host}, HTTP ${status})`);
    else {
      ok = false;
      out(`✗ Herkese açık adresten okunamadı (HTTP ${status || "bağlantı yok"}).`);
      out(
        "  Kontrol: bucket'a özel alan adı bağlı ve 'Active' mi; R2_PUBLIC_BASE_URL bu alan adı mı;",
      );
      out("  production/development bucket'ları ve alan adları karışmış olabilir mi.");
    }
  }

  try {
    await storage.delete(key);
    out("✓ Silme (DELETE) başarılı");
  } catch (err) {
    ok = false;
    out(`✗ Silme başarısız: ${err instanceof Error ? err.message : "bilinmeyen hata"}`);
  }
  out(ok ? "Depolama denetimi BAŞARILI." : "Depolama denetimi BAŞARISIZ.");
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    out(`✗ Beklenmeyen hata: ${err instanceof Error ? err.name : "bilinmeyen"}`);
    process.exit(1);
  },
);
