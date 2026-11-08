import Link from "next/link";

import type { SignupCta } from "@/config/marketing";
import { cn } from "@/lib/utils";

const SIZES = {
  md: "h-11 px-5 text-sm",
  lg: "h-12 px-6 text-base",
} as const;

const TONES = {
  dark: "bg-navy-900 text-white hover:bg-navy-800",
  light: "bg-white text-navy-900 hover:bg-turquoise-50",
} as const;

/** Deneme düğmesi: kayıt açıksa panel kayıt sayfası, kapalıysa sayfadaki deneme bölümü. */
export function TrialLink({
  cta,
  size = "md",
  tone = "dark",
  className,
}: {
  cta: SignupCta;
  size?: keyof typeof SIZES;
  tone?: keyof typeof TONES;
  className?: string;
}) {
  return (
    <Link
      href={cta.href}
      data-testid="trial-cta"
      data-signup={cta.open ? "open" : "closed"}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-xl font-semibold whitespace-nowrap shadow-sm transition-colors focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none",
        SIZES[size],
        TONES[tone],
        className,
      )}
    >
      {cta.label}
      <span aria-hidden="true">→</span>
    </Link>
  );
}
