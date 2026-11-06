/**
 * Kimlik e-postaları. Marka adı parametredir (koda gömülmez). Tüm dış değerler HTML-kaçışlıdır.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Rendered = { subject: string; html: string; text: string };

function layout(brand: string, heading: string, body: string, cta: { label: string; url: string }) {
  const b = escapeHtml(brand);
  const url = escapeHtml(cta.url);
  return `<!doctype html><html lang="tr"><body style="margin:0;padding:24px;background:#f5f8f8;font-family:Arial,Helvetica,sans-serif;color:#0b2f38">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
<tr><td>
<p style="margin:0 0 16px;font-weight:700;color:#0e4e5c">${b}</p>
<h1 style="margin:0 0 12px;font-size:20px">${escapeHtml(heading)}</h1>
<p style="margin:0 0 24px;line-height:1.5">${body}</p>
<p style="margin:0 0 24px"><a href="${url}" style="display:inline-block;background:#0e4e5c;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700">${escapeHtml(cta.label)}</a></p>
<p style="margin:0;font-size:12px;color:#4c6a71;line-height:1.5">Düğme çalışmazsa bu bağlantıyı tarayıcınıza yapıştırın:<br><span style="word-break:break-all">${url}</span></p>
</td></tr></table></body></html>`;
}

export function verifyEmailTemplate(p: { brand: string; name: string; url: string }): Rendered {
  const subject = `${p.brand} – e-posta adresinizi doğrulayın`;
  const body = `Merhaba ${escapeHtml(p.name)}, hesabınızı etkinleştirmek için e-posta adresinizi doğrulayın. Bağlantı 1 saat geçerlidir. Bu isteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz.`;
  return {
    subject,
    html: layout(p.brand, "E-posta adresinizi doğrulayın", body, {
      label: "E-postamı doğrula",
      url: p.url,
    }),
    text: `Merhaba ${p.name},\n\nHesabınızı etkinleştirmek için e-posta adresinizi doğrulayın (1 saat geçerli):\n${p.url}\n\nBu isteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz.\n\n${p.brand}`,
  };
}

export function resetPasswordTemplate(p: { brand: string; name: string; url: string }): Rendered {
  const subject = `${p.brand} – şifre sıfırlama`;
  const body = `Merhaba ${escapeHtml(p.name)}, şifrenizi sıfırlamak için aşağıdaki düğmeyi kullanın. Bağlantı 1 saat geçerlidir. Bu isteği siz yapmadıysanız şifreniz değişmez; bu e-postayı yok sayabilirsiniz.`;
  return {
    subject,
    html: layout(p.brand, "Şifre sıfırlama", body, { label: "Yeni şifre belirle", url: p.url }),
    text: `Merhaba ${p.name},\n\nŞifrenizi sıfırlamak için (1 saat geçerli):\n${p.url}\n\nBu isteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz.\n\n${p.brand}`,
  };
}
