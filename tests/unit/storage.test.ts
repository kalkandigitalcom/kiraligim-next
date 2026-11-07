import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { buildCsp } from "@/lib/security-headers";
import { mediaOriginForCsp, parseStorageConfig } from "@/server/storage/env";
import { createFilesystemStorage, resolveInside } from "@/server/storage/filesystem";
import { createMemoryStorage } from "@/server/storage/memory";
import { createR2Storage } from "@/server/storage/r2";
import { IMMUTABLE_CACHE_CONTROL, isSafeKey, StorageError } from "@/server/storage/types";

const KEY =
  "w/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/p/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d/400.webp";

// Örnek değerler (gerçek değil).
const R2 = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "AKIAEXAMPLEKEY0000000000",
  R2_SECRET_ACCESS_KEY: "ornekGizliAnahtar0000000000000000000000000000000000000000000000",
  R2_BUCKET: "kiraligim-media-dev",
  R2_PUBLIC_BASE_URL: "https://img-dev.kiraligim.com",
};

describe("depolama anahtarı", () => {
  it.each([KEY, "healthcheck/abc.txt", "a"])("güvenli: %s", (k) => expect(isSafeKey(k)).toBe(true));
  it.each([
    "",
    "/w/x",
    "w//x",
    "w/../x",
    "w/./x",
    "../x",
    "w/x/",
    "W/X",
    "w/x?y",
    "w/x%2f",
    "w\\x",
    "w/x y",
    "a".repeat(513),
  ])("reddedilir: %j", (k) => expect(isSafeKey(k)).toBe(false));
});

describe("bellek sürücüsü", () => {
  it("yazar, siler, herkese açık adres üretir; güvensiz anahtarı reddeder", async () => {
    const s = createMemoryStorage("https://img.test.invalid");
    await s.put(KEY, new Uint8Array([1, 2, 3]), { contentType: "image/webp" });
    expect(s.objects.get(KEY)?.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(s.publicUrl(KEY)).toBe(`https://img.test.invalid/${KEY}`);
    await s.delete(KEY);
    await s.delete(KEY);
    expect(s.objects.size).toBe(0);
    await expect(s.put("../x", new Uint8Array(1), { contentType: "x" })).rejects.toThrow(
      StorageError,
    );
  });
});

describe("dosya sistemi sürücüsü (yerel geliştirme)", () => {
  let dir: string;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("kök dizin dışına çıkamaz; üzerine yazmaz; okur ve siler", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "kg-storage-"));
    const s = createFilesystemStorage(dir);
    await s.put(KEY, new Uint8Array([9, 8, 7]), { contentType: "image/webp" });
    expect(await readFile(path.join(dir, ...KEY.split("/")))).toEqual(Buffer.from([9, 8, 7]));
    expect(await s.read(KEY)).toEqual(Buffer.from([9, 8, 7]));
    await expect(s.put(KEY, new Uint8Array([1]), { contentType: "image/webp" })).rejects.toThrow();
    expect(s.publicUrl(KEY)).toBe(`/api/medya/${KEY}`);
    await s.delete(KEY);
    await s.delete(KEY);
    expect(await s.read(KEY)).toBeNull();
    expect(() => resolveInside(dir, "../etc/passwd")).toThrow(StorageError);
    expect(() => resolveInside(dir, "a/../../b")).toThrow(StorageError);
    expect(await s.read("../../etc/passwd")).toBeNull();
  });
});

describe("R2 sürücüsü (sahte fetch)", () => {
  const make = (handler: (r: Request) => Promise<Response> | Response) => {
    const seen: Request[] = [];
    const storage = createR2Storage({
      accountId: R2.R2_ACCOUNT_ID,
      accessKeyId: R2.R2_ACCESS_KEY_ID,
      secretAccessKey: R2.R2_SECRET_ACCESS_KEY,
      bucket: R2.R2_BUCKET,
      publicBaseUrl: R2.R2_PUBLIC_BASE_URL,
      fetchImpl: async (r) => {
        seen.push(r.clone());
        return handler(r);
      },
    });
    return { storage, seen };
  };

  it("PUT: doğru uç nokta, SigV4 imzası, gövde özeti, içerik türü ve önbellek başlığı", async () => {
    const { storage, seen } = make(() => new Response(null, { status: 200 }));
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    await storage.put(KEY, body, {
      contentType: "image/webp",
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    });
    const r = seen[0]!;
    expect(r.method).toBe("PUT");
    expect(r.url).toBe(
      `https://${R2.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2.R2_BUCKET}/${KEY}`,
    );
    const auth = r.headers.get("authorization") ?? "";
    expect(auth).toMatch(
      new RegExp(
        `^AWS4-HMAC-SHA256 Credential=${R2.R2_ACCESS_KEY_ID}/\\d{8}/auto/s3/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$`,
      ),
    );
    expect(auth).not.toContain(R2.R2_SECRET_ACCESS_KEY);
    expect(r.headers.get("x-amz-content-sha256")).toBe(
      createHash("sha256").update(body).digest("hex"),
    );
    expect(r.headers.get("content-type")).toBe("image/webp");
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(body);
    expect(storage.publicUrl(KEY)).toBe(`https://img-dev.kiraligim.com/${KEY}`);
  });

  it("hata yanıtı: yalnız durum kodu; gövde ve sırlar mesaja taşınmaz", async () => {
    const { storage } = make(
      () =>
        new Response("<Error><Code>AccessDenied</Code><Secret>xyz</Secret></Error>", {
          status: 403,
        }),
    );
    const err = await storage
      .put(KEY, new Uint8Array([1]), { contentType: "image/webp" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    const msg = (err as Error).message;
    expect(msg).toContain("403");
    expect(msg).not.toMatch(/AccessDenied|xyz|AKIA|ornekGizli/);
  });

  it("ağ hatası / zaman aşımı StorageError olur", async () => {
    const { storage } = make(() => {
      const e = new Error("t");
      e.name = "TimeoutError";
      throw e;
    });
    await expect(storage.delete(KEY)).rejects.toThrow(/zaman aşımı/);
  });

  it("DELETE: 204 ve 404 başarılı, 500 hata", async () => {
    let status = 204;
    const { storage, seen } = make(() => new Response(null, { status }));
    await storage.delete(KEY);
    expect(seen[0]!.method).toBe("DELETE");
    status = 404;
    await storage.delete(KEY);
    status = 500;
    await expect(storage.delete(KEY)).rejects.toThrow(StorageError);
  });

  it("güvensiz anahtarla istek gönderilmez", async () => {
    const { storage, seen } = make(() => new Response(null, { status: 200 }));
    await expect(storage.put("../x", new Uint8Array(1), { contentType: "x" })).rejects.toThrow();
    await expect(storage.delete("w/../x")).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
});

describe("depolama ortam değişkenleri", () => {
  const issuesOf = (src: Record<string, string>) => {
    const r = parseStorageConfig(src);
    return r.ok ? [] : r.issues;
  };

  it("varsayılan sürücüler: local → filesystem, test → memory, dev/prod → r2", () => {
    expect(parseStorageConfig({ APP_ENV: "local" })).toEqual({
      ok: true,
      config: { driver: "filesystem", localDir: ".storage" },
    });
    expect(parseStorageConfig({ APP_ENV: "test" })).toEqual({
      ok: true,
      config: { driver: "memory" },
    });
    const prod = parseStorageConfig({ APP_ENV: "production" });
    expect(prod.ok).toBe(false);
    expect(prod.ok ? null : prod.driver).toBe("r2");
  });

  it("geliştirme sunucusu: geçerli R2 değerleriyle yapılandırılır", () => {
    const r = parseStorageConfig({ APP_ENV: "development", ...R2 });
    expect(r).toEqual({
      ok: true,
      config: {
        driver: "r2",
        r2: {
          accountId: R2.R2_ACCOUNT_ID,
          accessKeyId: R2.R2_ACCESS_KEY_ID,
          secretAccessKey: R2.R2_SECRET_ACCESS_KEY,
          bucket: "kiraligim-media-dev",
          publicBaseUrl: "https://img-dev.kiraligim.com",
        },
      },
    });
  });

  it("production ve development yalnız r2 kullanabilir; memory yalnız testte", () => {
    expect(issuesOf({ APP_ENV: "production", STORAGE_DRIVER: "filesystem" })).toEqual([
      "STORAGE_DRIVER: APP_ENV=production iken yalnız r2 kullanılabilir",
    ]);
    expect(issuesOf({ APP_ENV: "development", STORAGE_DRIVER: "memory" })).toHaveLength(1);
    expect(issuesOf({ APP_ENV: "local", STORAGE_DRIVER: "memory" })).toHaveLength(1);
  });

  it("bucket adı ortamla eşleşmeli (-prod / -dev)", () => {
    expect(issuesOf({ APP_ENV: "production", ...R2 })).toEqual([
      'R2_BUCKET: APP_ENV=production iken bucket adı "-prod" ile bitmeli',
    ]);
    expect(
      issuesOf({ APP_ENV: "development", ...R2, R2_BUCKET: "kiraligim-media-prod" }),
    ).toHaveLength(1);
    expect(
      parseStorageConfig({
        APP_ENV: "production",
        ...R2,
        R2_BUCKET: "kiraligim-media-prod",
        R2_PUBLIC_BASE_URL: "https://img.kiraligim.com",
      }).ok,
    ).toBe(true);
  });

  it("CDN adresi https kök adres olmalı; hatalarda değerler yazılmaz", () => {
    for (const url of [
      "http://img-dev.kiraligim.com",
      "https://img-dev.kiraligim.com/yol",
      "https://img-dev.kiraligim.com/?a=1",
      "https://kullanici:parola@img-dev.kiraligim.com",
      "img-dev.kiraligim.com",
    ]) {
      expect(issuesOf({ APP_ENV: "development", ...R2, R2_PUBLIC_BASE_URL: url })).toHaveLength(1);
    }
    const issues = issuesOf({
      APP_ENV: "development",
      ...R2,
      R2_ACCOUNT_ID: "kısa",
      R2_SECRET_ACCESS_KEY: "x",
    });
    expect(issues.map((i) => i.split(":")[0])).toEqual(["R2_ACCOUNT_ID", "R2_SECRET_ACCESS_KEY"]);
    expect(issues.join(" ")).not.toMatch(/kısa|AKIA/);
  });

  it("eksik R2 değişkenleri yalnız adlarıyla raporlanır", () => {
    expect(issuesOf({ APP_ENV: "development" }).map((i) => i.split(":")[0])).toEqual([
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET",
      "R2_PUBLIC_BASE_URL",
    ]);
  });
});

describe("CSP: fotoğraf CDN'i", () => {
  it("geçerli https kökeni img-src'ye eklenir; diğer yönergeler değişmez", () => {
    const origin = mediaOriginForCsp({ R2_PUBLIC_BASE_URL: "https://img.kiraligim.com/" });
    expect(origin).toBe("https://img.kiraligim.com");
    const csp = buildCsp("n", { isDev: false, imgOrigins: [origin!] });
    expect(csp).toContain("img-src 'self' blob: data: https://img.kiraligim.com;");
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("default-src 'self';");
  });

  it("geçersiz / güvensiz değerler eklenmez", () => {
    for (const v of ["", "http://img.kiraligim.com", "javascript:alert(1)", "https://a:b@x.com"]) {
      expect(mediaOriginForCsp({ R2_PUBLIC_BASE_URL: v })).toBeNull();
    }
    expect(mediaOriginForCsp({})).toBeNull();
    const csp = buildCsp("n", {
      isDev: false,
      imgOrigins: ["https://*.ornek.com", "'unsafe-inline'"],
    });
    expect(csp).toContain("img-src 'self' blob: data:;");
  });
});
