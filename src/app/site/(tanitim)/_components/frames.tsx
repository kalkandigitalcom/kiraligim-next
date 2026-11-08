// next/image satır içi style ekler (CSP); bu yüzden <picture>/<img> kullanılır.
import { cn } from "@/lib/utils";

import type { Shot } from "./shots";

/** AVIF + WebP kaynaklı resim; genişlik/yükseklik verilir (yerleşim kayması yok). */
export function ShotPicture({
  shot,
  alt,
  sizes,
  priority = false,
  className,
}: {
  shot: Shot;
  alt: string;
  sizes: string;
  priority?: boolean;
  className?: string;
}) {
  const set = (ext: string) =>
    shot.widths.map((w) => `/marketing/${shot.name}-${w}.${ext} ${w}w`).join(", ");
  return (
    <picture>
      <source type="image/avif" srcSet={set("avif")} sizes={sizes} />
      <source type="image/webp" srcSet={set("webp")} sizes={sizes} />
      <img
        src={`/marketing/${shot.name}-${shot.widths.at(-1)}.webp`}
        alt={alt}
        width={shot.w}
        height={shot.h}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        decoding="async"
        className={cn("block h-auto w-full", className)}
      />
    </picture>
  );
}

export function DemoPhoto({
  name,
  alt,
  className,
}: {
  name: string;
  alt: string;
  className?: string;
}) {
  return (
    <picture>
      <source type="image/avif" srcSet={`/marketing/${name}-720.avif`} />
      <img
        src={`/marketing/${name}-720.webp`}
        alt={alt}
        width={720}
        height={480}
        loading="lazy"
        decoding="async"
        className={cn("block h-full w-full object-cover", className)}
      />
    </picture>
  );
}

/** Tarayıcı çerçevesi: gerçek panel ekranını ürün gibi sunar. */
export function BrowserFrame({
  url,
  children,
  className,
  dark = false,
}: {
  url: string;
  children: React.ReactNode;
  className?: string;
  dark?: boolean;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border shadow-2xl",
        dark
          ? "border-white/10 bg-navy-800 shadow-black/40"
          : "border-navy-900/10 bg-white shadow-navy-900/15",
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center gap-3 border-b px-4 py-2.5",
          dark ? "border-white/10" : "border-navy-900/8 bg-mist",
        )}
      >
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-[#ff5f57]" />
          <span className="size-2.5 rounded-full bg-[#febc2e]" />
          <span className="size-2.5 rounded-full bg-[#28c840]" />
        </span>
        <span
          className={cn(
            "mx-auto truncate rounded-md px-3 py-1 text-[11px] font-medium",
            dark ? "bg-white/10 text-white/70" : "bg-white text-navy-900/60",
          )}
        >
          {url}
        </span>
        <span className="w-10" aria-hidden="true" />
      </div>
      {children}
    </div>
  );
}

/** Telefon çerçevesi. */
export function PhoneFrame({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative rounded-[2.6rem] border border-navy-900/20 bg-navy-950 p-2.5 shadow-2xl shadow-navy-900/30",
        className,
      )}
    >
      <div
        className="absolute top-4 left-1/2 z-10 h-5 w-20 -translate-x-1/2 rounded-full bg-navy-950"
        aria-hidden="true"
      />
      <div className="overflow-hidden rounded-[2.1rem] bg-white">{children}</div>
    </div>
  );
}
