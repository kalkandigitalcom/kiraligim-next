import { escapeHtml } from "@/lib/email/templates";
import { formatStay, nightsBetween } from "@/lib/reservation-meta";

/**
 * Ev sahibine "yeni rezervasyon talebi" e-postası. Misafirin adı, telefonu, e-postası, notu ve
 * tutar YAZILMAZ (kişisel veri e-postada dolaşmasın); yalnız villa, tarih, kişi sayısı, talep
 * numarası ve panel bağlantısı. Ayrıntılar giriş yapılmış panelde görülür.
 */
export function reservationRequestEmail(p: {
  brand: string;
  villaName: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  reference: string;
  url: string;
}): { subject: string; html: string; text: string } {
  const stay = `${formatStay(p.checkIn, p.checkOut)} (${nightsBetween(p.checkIn, p.checkOut)} gece, ${p.guests} kişi)`;
  const subject = `${p.brand} – ${p.villaName} için yeni rezervasyon talebi`;
  const b = escapeHtml(p.brand);
  const url = escapeHtml(p.url);
  const html = `<!doctype html><html lang="tr"><body style="margin:0;padding:24px;background:#f5f8f8;font-family:Arial,Helvetica,sans-serif;color:#0b2f38">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
<tr><td>
<p style="margin:0 0 16px;font-weight:700;color:#0e4e5c">${b}</p>
<h1 style="margin:0 0 12px;font-size:20px">Yeni rezervasyon talebi</h1>
<p style="margin:0 0 8px;line-height:1.5"><strong>${escapeHtml(p.villaName)}</strong></p>
<p style="margin:0 0 8px;line-height:1.5">${escapeHtml(stay)}</p>
<p style="margin:0 0 24px;line-height:1.5;color:#4c6a71">Talep no: ${escapeHtml(p.reference)}. Talep beklemede; siz onaylayana kadar kesin rezervasyon değildir. Misafir bilgilerini panelde görebilirsiniz.</p>
<p style="margin:0 0 24px"><a href="${url}" style="display:inline-block;background:#0e4e5c;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700">Talebi görüntüle</a></p>
<p style="margin:0;font-size:12px;color:#4c6a71;line-height:1.5">Düğme çalışmazsa bu bağlantıyı tarayıcınıza yapıştırın:<br><span style="word-break:break-all">${url}</span></p>
</td></tr></table></body></html>`;
  const text = `Yeni rezervasyon talebi\n\n${p.villaName}\n${stay}\nTalep no: ${p.reference}\n\nTalep beklemede; siz onaylayana kadar kesin rezervasyon değildir. Misafir bilgilerini panelde görebilirsiniz:\n${p.url}\n\n${p.brand}`;
  return { subject, html, text };
}
