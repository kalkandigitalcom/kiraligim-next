import { describe, expect, it, vi } from "vitest";

import { escapeHtml, resetPasswordTemplate, verifyEmailTemplate } from "@/lib/email/templates";
import {
  createLogTransport,
  createMemoryTransport,
  createResendTransport,
  maskEmail,
} from "@/lib/email/transports";
import { createLogger } from "@/lib/logger";

const writes: string[] = [];
vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
  writes.push(String(chunk));
  return true;
});

const message = {
  to: "ali.veli@ornek.com",
  subject: "Konu",
  html: "<p>gizli-icerik</p>",
  text: "gizli-icerik",
  category: "auth.verify-email",
  idempotencyKey: "abc-123",
};

describe("Resend gönderimi", () => {
  it("doğru uç noktaya, başlıklarla ve gövdeyle gönderir", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }),
    );
    const t = createResendTransport({
      apiKey: "re_cokgizli",
      from: "Kiralığım <bildirim@kiraligim.com>",
      replyTo: "destek@kiraligim.com",
      fetchImpl,
    });
    await expect(t.send(message)).resolves.toEqual({ id: "msg_1" });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer re_cokgizli");
    expect(headers["idempotency-key"]).toBe("abc-123");
    expect(JSON.parse(String(init.body))).toMatchObject({
      from: "Kiralığım <bildirim@kiraligim.com>",
      to: ["ali.veli@ornek.com"],
      subject: "Konu",
      reply_to: "destek@kiraligim.com",
      tags: [{ name: "category", value: "auth_verify-email" }],
    });
  });

  it("hata yanıtında anahtar, içerik ve tam adres log'a düşmez", async () => {
    writes.length = 0;
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ message: "re_cokgizli invalid" }), { status: 422 }),
    );
    const t = createResendTransport({ apiKey: "re_cokgizli", from: "x@kiraligim.com", fetchImpl });
    await expect(t.send(message)).rejects.toThrow("E-posta gönderilemedi");
    const out = writes.join("");
    expect(out).toContain('"status":422');
    expect(out).not.toMatch(/re_cokgizli|gizli-icerik|ali\.veli/);
  });

  it("ağ hatasını yakalar", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const t = createResendTransport({ apiKey: "re_x", from: "x@kiraligim.com", fetchImpl });
    await expect(t.send(message)).rejects.toThrow("E-posta gönderilemedi");
  });
});

describe("geliştirme ve test gönderimi", () => {
  it("bellek gönderimi iletiyi saklar, dışarı çıkmaz", async () => {
    const t = createMemoryTransport();
    await t.send(message);
    expect(t.outbox).toHaveLength(1);
    expect(t.outbox[0]?.to).toBe("ali.veli@ornek.com");
  });

  it("log gönderimi iletiyi log'a yazar", async () => {
    const lines: string[] = [];
    await createLogTransport(createLogger({}, (l) => lines.push(l))).send(message);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      msg: "email_logged",
      text: "gizli-icerik",
    });
  });

  it("adres maskelenir", () => {
    expect(maskEmail("ali.veli@ornek.com")).toBe("a***@ornek.com");
  });
});

describe("şablonlar", () => {
  it("dış değerler HTML'de kaçışlanır", () => {
    const t = verifyEmailTemplate({
      brand: "Kiralığım",
      name: '<script>alert("x")</script>',
      url: 'https://app.kiraligim.com/v?t=1&x="',
    });
    expect(t.html).not.toContain("<script>");
    expect(t.html).toContain("&lt;script&gt;");
    expect(t.html).toContain("&amp;x=&quot;");
    expect(escapeHtml("'")).toBe("&#39;");
  });

  it("Türkçe konu ve düz metin sürümü vardır", () => {
    const t = resetPasswordTemplate({ brand: "Kiralığım", name: "Ayşe", url: "https://x.test/r" });
    expect(t.subject).toBe("Kiralığım – şifre sıfırlama");
    expect(t.text).toContain("https://x.test/r");
  });
});
