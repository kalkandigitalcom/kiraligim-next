"use client";

import { useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";

/**
 * Villa sayfası bağlantısı: kopyala ve WhatsApp'ta paylaş. Bağlantıyı kopyalamak zararsızdır;
 * tüm üyelere (staff dahil) açıktır. Önizleme yalnız owner/manager içindir (Yayın durumu bölümü).
 */
export function ShareLink({ url, message }: { url: string; message: string }) {
  const hydrated = useHydrated();
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <p
        className="rounded-lg border border-border bg-mist px-3 py-2.5 font-mono text-sm break-all text-navy-900"
        data-testid="public-url"
      >
        {url}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!hydrated}
          onClick={() => {
            navigator.clipboard
              ?.writeText(url)
              .then(() => setCopied("ok"))
              .catch(() => setCopied("fail"));
          }}
        >
          Bağlantıyı kopyala
        </Button>
        <a
          href={`https://wa.me/?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ size: "sm", variant: "secondary" })}
          data-testid="share-whatsapp"
        >
          WhatsApp&apos;ta paylaş
        </a>
        <span className="text-sm text-turquoise-700" role="status">
          {copied === "ok"
            ? "Kopyalandı."
            : copied === "fail"
              ? "Kopyalanamadı; adresi elle seçin."
              : ""}
        </span>
      </div>
    </div>
  );
}
