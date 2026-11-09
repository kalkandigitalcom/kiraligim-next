import { crc32 } from "node:zlib";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { ImageRejectedError, processImage, sniffFormat } from "@/server/media/image";

/**
 * Gerçek sharp/libvips ile görsel işleme. Görseller test içinde üretilir (dosya yok).
 */
const noise = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 40, g: 120, b: 200 },
      noise: { type: "gaussian", mean: 128, sigma: 40 },
    },
  });

const flat = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 20 } } });

const reason = (p: Promise<unknown>) =>
  p.then(
    () => "başarılı (red bekleniyordu)",
    (e: unknown) => (e instanceof ImageRejectedError ? e.reason : String(e)),
  );

describe("biçim tespiti (dosya baytları)", () => {
  it("JPEG, PNG ve WebP imzalarını tanır; diğerlerini reddeder", async () => {
    expect(sniffFormat(await flat(4, 4).jpeg().toBuffer())).toBe("jpeg");
    expect(sniffFormat(await flat(4, 4).png().toBuffer())).toBe("png");
    expect(sniffFormat(await flat(4, 4).webp().toBuffer())).toBe("webp");
    expect(sniffFormat(await flat(4, 4).gif().toBuffer())).toBeNull();
    expect(sniffFormat(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffFormat(Buffer.from("merhaba"))).toBeNull();
    expect(sniffFormat(new Uint8Array())).toBeNull();
  });
});

describe("processImage", () => {
  it("3 WebP varyantı üretir: 2000 / 1200 / 400 px genişlik, oran korunur", async () => {
    const out = await processImage(await noise(3000, 2000).jpeg({ quality: 90 }).toBuffer());
    expect(out.format).toBe("jpeg");
    expect(out.variants.map((v) => [v.width, v.pixelWidth, v.pixelHeight])).toEqual([
      [400, 400, 267],
      [1200, 1200, 800],
      [2000, 2000, 1333],
    ]);
    expect({ width: out.width, height: out.height }).toEqual({ width: 2000, height: 1333 });
    for (const v of out.variants) {
      const m = await sharp(v.data).metadata();
      expect(m.format).toBe("webp");
      expect(m.width).toBe(v.pixelWidth);
    }
  });

  it("küçük görsel büyütülmez (tüm varyantlar orijinal genişlikte)", async () => {
    const out = await processImage(await flat(300, 200).png().toBuffer());
    expect(out.variants.map((v) => [v.width, v.pixelWidth, v.pixelHeight])).toEqual([
      [400, 300, 200],
      [1200, 300, 200],
      [2000, 300, 200],
    ]);
  });

  it("EXIF, GPS, XMP ve ICC kaldırılır; EXIF yönü piksellere uygulanır", async () => {
    const input = await flat(200, 100)
      .withExif({
        IFD0: { Make: "TestKamera", Model: "X1", Copyright: "Gizli Kişi" },
        IFD3: { GPSLatitudeRef: "N", GPSLatitude: "36/1 15/1 30/1" },
      })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const inMeta = await sharp(input).metadata();
    expect(inMeta.exif).toBeDefined();
    expect(inMeta.orientation).toBe(6);
    expect(inMeta.exif!.toString("latin1")).toContain("TestKamera");

    const out = await processImage(input);
    for (const v of out.variants) {
      const m = await sharp(v.data).metadata();
      expect(m.exif).toBeUndefined();
      expect(m.xmp).toBeUndefined();
      expect(m.icc).toBeUndefined();
      expect(m.iptc).toBeUndefined();
      expect(m.orientation).toBeUndefined();
      // 90° döndürülmüş: 200x100 → 100x200
      expect([m.width, m.height]).toEqual([100, 200]);
      const raw = v.data.toString("latin1");
      expect(raw).not.toContain("TestKamera");
      expect(raw).not.toContain("Gizli Kişi");
      expect(raw).not.toContain("Exif");
    }
  });

  it("PNG ve WebP girişleri de WebP'ye dönüşür", async () => {
    for (const buf of [await flat(50, 40).png().toBuffer(), await flat(50, 40).webp().toBuffer()]) {
      const out = await processImage(buf);
      expect(out.variants).toHaveLength(3);
      expect((await sharp(out.variants[0]!.data).metadata()).format).toBe("webp");
    }
  });

  it("desteklenmeyen biçimler reddedilir: GIF, SVG, HEIC, metin, sahte uzantı", async () => {
    expect(await reason(processImage(await flat(10, 10).gif().toBuffer()))).toBe(
      "unsupported_format",
    );
    expect(
      await reason(
        processImage(
          Buffer.from(
            "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><rect width='10' height='10'/></svg>",
          ),
        ),
      ),
    ).toBe("unsupported_format");
    // HEIC: ftyp kutusu (….ftypheic)
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from("ftypheic"),
      Buffer.alloc(32),
    ]);
    expect(await reason(processImage(heic))).toBe("unsupported_format");
    expect(await reason(processImage(Buffer.from("bu bir fotoğraf değil")))).toBe(
      "unsupported_format",
    );
    // .jpg adıyla gelen PHP/HTML: biçim dosya baytlarından belirlendiği için reddedilir.
    expect(await reason(processImage(Buffer.from("<?php echo 1; ?>")))).toBe("unsupported_format");
  });

  it("JPEG imzası taşıyan bozuk dosya reddedilir", async () => {
    const jpeg = await noise(64, 64).jpeg().toBuffer();
    const broken = Buffer.concat([jpeg.subarray(0, 40), Buffer.alloc(200, 0x41)]);
    expect(await reason(processImage(broken))).toBe("corrupt");
    // İmza JPEG, içerik PNG → uyuşmazlık
    const png = await flat(10, 10).png().toBuffer();
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), png]);
    expect(["corrupt", "unsupported_format"]).toContain(await reason(processImage(fake)));
  });

  it("hareketli WebP reddedilir", async () => {
    const frame = await flat(20, 20).png().toBuffer();
    const frame2 = await flat(20, 20).negate().png().toBuffer();
    const animated = await sharp([frame, frame2], { join: { animated: true } })
      .webp({ loop: 0 })
      .toBuffer();
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(2);
    expect(await reason(processImage(animated))).toBe("animated");
  });

  it("piksel sınırı (dekompresyon bombası) aşılırsa reddedilir", async () => {
    const buf = await flat(200, 200).png().toBuffer();
    expect(await reason(processImage(buf, { maxInputPixels: 10_000 }))).toBe("too_many_pixels");
    // Başlığı 8000 x 7000 (= 56 MP > 50 MP) diyen küçük PNG: pikseller çözülmeden reddedilir.
    const bomb = await flat(8, 8).png().toBuffer();
    bomb.writeUInt32BE(8000, 16);
    bomb.writeUInt32BE(7000, 20);
    bomb.writeUInt32BE(crc32(bomb.subarray(12, 29)), 29);
    expect(await reason(processImage(bomb))).toBe("too_many_pixels");
  }, 30_000);

  // Gürültülü 1600x1200 görsel (sıkıştırılamaz) üç kez işlenir; tek iş parçacıklı libvips
  // (sharp.concurrency(1)) ile WebP kodlaması paylaşımlı CI makinesinde 5 sn'yi aşabiliyor.
  it("varyant sınırı aşılırsa kalite basamaklarla düşürülür", async () => {
    const input = await noise(1600, 1200).png().toBuffer();
    const low = await processImage(input, { qualities: [50] });
    const lowBytes = Math.max(...low.variants.map((v) => v.data.length));
    const high = await processImage(input, { qualities: [90] });
    expect(Math.max(...high.variants.map((v) => v.data.length))).toBeGreaterThan(lowBytes);

    const out = await processImage(input, { qualities: [90, 70, 50], maxVariantBytes: lowBytes });
    expect(out.variants.every((v) => v.data.length <= lowBytes)).toBe(true);
    expect(out.quality).toBeLessThan(90);
    // Küçük varyant ilk basamakta sığar; kayıtta en düşük kalite tutulur.
    expect(out.variants.find((v) => v.width === 400)!.quality).toBe(90);
    expect(out.quality).toBe(Math.min(...out.variants.map((v) => v.quality)));
  }, 15_000);

  it("en düşük kalitede de sınır aşılırsa tüm yükleme reddedilir", async () => {
    const input = await noise(800, 600).jpeg().toBuffer();
    expect(await reason(processImage(input, { maxVariantBytes: 500 }))).toBe("output_too_large");
  });
});
