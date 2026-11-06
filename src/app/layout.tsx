import type { Metadata } from "next";
import { headers } from "next/headers";

import { getBrand } from "@/config/brand";

import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const brand = getBrand();
  return {
    title: { default: brand.name, template: `%s · ${brand.name}` },
    robots: { index: false, follow: false },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // İstek başlıklarını okumak sayfayı dinamik yapar; Next.js CSP nonce'unu script'lere uygular.
  await headers();
  return (
    <html lang="tr" className="h-full">
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}
