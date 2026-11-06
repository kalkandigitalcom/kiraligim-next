"use client";

/** Kök layout'ta oluşan hatalar için en son güvenlik ağı. */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="tr">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "4rem 1.5rem" }}>
        <h1>Bir şeyler ters gitti</h1>
        <p>Lütfen sayfayı yenileyin.{error.digest ? ` Hata kodu: ${error.digest}` : ""}</p>
      </body>
    </html>
  );
}
