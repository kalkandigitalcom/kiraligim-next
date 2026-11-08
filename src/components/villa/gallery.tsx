"use client";

/* eslint-disable @next/next/no-img-element -- next/image satır içi style ekler; CSP (style-src nonce) bunu engeller. Boyutlar width/height ile verilir (CLS yok). */

import { useCallback, useEffect, useRef, useState } from "react";

import type { PublicPhoto } from "@/lib/public-villa";
import { cn } from "@/lib/utils";

type Photo = Pick<PublicPhoto, "src" | "srcSet" | "large" | "width" | "height">;

const DESKTOP_TILES = 5;

/**
 * Villa galerisi: masaüstünde kapak + 4 kare mozaik, mobilde kaydırmalı şerit (scroll-snap).
 * Her kare büyük fotoğrafa bağlantıdır: JavaScript yoksa bağlantı fotoğrafı açar; varsa tam ekran
 * <dialog> açılır (ok tuşları, kaydırma, Esc). Satır içi stil yok (CSP).
 */
export function Gallery({ photos, name }: { photos: Photo[]; name: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState<number | null>(null);
  const total = photos.length;
  const alt = (i: number) => `${name} – fotoğraf ${i + 1} / ${total}`;

  const open = useCallback((i: number) => {
    setIndex(i);
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
    document.documentElement.classList.add("overflow-hidden");
  }, []);
  const close = useCallback(() => dialogRef.current?.close(), []);
  const step = useCallback(
    (delta: number) => setIndex((i) => (i === null ? i : (i + delta + total) % total)),
    [total],
  );

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    const onClose = () => {
      setIndex(null);
      document.documentElement.classList.remove("overflow-hidden");
    };
    d.addEventListener("close", onClose);
    return () => {
      d.removeEventListener("close", onClose);
      document.documentElement.classList.remove("overflow-hidden");
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      step(-1);
    }
  };

  const touchX = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => (touchX.current = e.touches[0]?.clientX ?? null);
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchX.current;
    const end = e.changedTouches[0]?.clientX;
    touchX.current = null;
    if (start === null || end === undefined || Math.abs(end - start) < 40) return;
    step(end < start ? 1 : -1);
  };

  const tile = (p: Photo, i: number, className: string, sizes: string) => (
    <a
      key={p.large}
      href={p.large}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        open(i);
      }}
      className={cn(
        "group relative block overflow-hidden bg-mist focus-visible:ring-3 focus-visible:ring-turquoise-500/60 focus-visible:outline-none",
        className,
      )}
      aria-label={`${alt(i)} – büyüt`}
    >
      <img
        src={p.src}
        srcSet={p.srcSet}
        sizes={sizes}
        width={p.width}
        height={p.height}
        alt={alt(i)}
        loading={i === 0 ? "eager" : "lazy"}
        fetchPriority={i === 0 ? "high" : undefined}
        decoding="async"
        className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
      />
    </a>
  );

  const current = index === null ? null : photos[index];
  // Fotoğraf yoksa (depolama yapılandırılmamış) boş kutu ve "0 fotoğraf" gösterilmez.
  if (total === 0) return null;

  return (
    <div data-testid="villa-gallery">
      {/* Mobil: kaydırmalı şerit */}
      <div className="-mx-4 flex snap-x snap-mandatory [scrollbar-width:none] gap-2 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6 md:hidden">
        {photos.map((p, i) =>
          tile(p, i, "aspect-[4/3] w-[86%] shrink-0 snap-center rounded-2xl", "86vw"),
        )}
      </div>

      {/* Masaüstü: mozaik */}
      <div
        className={cn(
          "relative hidden h-[30rem] gap-2 overflow-hidden rounded-3xl md:grid lg:h-[34rem]",
          total === 1
            ? "grid-cols-1"
            : total < DESKTOP_TILES
              ? "grid-cols-2"
              : "grid-cols-4 grid-rows-2",
        )}
      >
        {photos
          .slice(0, total < DESKTOP_TILES ? Math.min(total, 2) : DESKTOP_TILES)
          .map((p, i) =>
            tile(
              p,
              i,
              i === 0 && total >= DESKTOP_TILES ? "col-span-2 row-span-2" : "",
              i === 0 ? "(min-width: 1152px) 576px, 50vw" : "(min-width: 1152px) 288px, 25vw",
            ),
          )}
        {total > 1 && (
          <button
            type="button"
            onClick={() => open(0)}
            className="absolute right-4 bottom-4 inline-flex items-center gap-2 rounded-xl border border-navy-900/10 bg-white/95 px-4 py-2.5 text-sm font-semibold text-navy-900 shadow-lg shadow-navy-900/10 backdrop-blur hover:bg-white focus-visible:ring-3 focus-visible:ring-turquoise-500/50 focus-visible:outline-none"
          >
            <GridIcon />
            Tüm fotoğraflar ({total})
          </button>
        )}
      </div>
      <p className="mt-2 text-sm text-navy-900/60 md:hidden">
        {total} fotoğraf · büyütmek için dokunun
      </p>

      <dialog
        ref={dialogRef}
        aria-label={`${name} fotoğrafları`}
        onKeyDown={onKeyDown}
        className="m-0 h-dvh max-h-none w-screen max-w-none bg-navy-950 p-0 text-white backdrop:bg-navy-950/95"
      >
        {current && index !== null && (
          <div className="flex h-full flex-col" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
            <div className="flex items-center justify-between gap-4 px-4 py-3 sm:px-6">
              <p className="text-sm font-medium text-white/80" aria-live="polite">
                {index + 1} / {total}
              </p>
              <button
                type="button"
                onClick={close}
                autoFocus
                className="inline-flex size-11 items-center justify-center rounded-full text-white hover:bg-white/10 focus-visible:ring-3 focus-visible:ring-turquoise-500/60 focus-visible:outline-none"
                aria-label="Kapat"
              >
                <CloseIcon />
              </button>
            </div>
            <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-4 sm:px-16">
              <img
                key={current.large}
                src={current.large}
                srcSet={current.srcSet}
                sizes="100vw"
                width={current.width}
                height={current.height}
                alt={alt(index)}
                className="max-h-full max-w-full rounded-lg object-contain select-none"
              />
              {total > 1 && (
                <>
                  <NavButton side="left" label="Önceki fotoğraf" onClick={() => step(-1)} />
                  <NavButton side="right" label="Sonraki fotoğraf" onClick={() => step(1)} />
                </>
              )}
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
}

function NavButton({
  side,
  label,
  onClick,
}: {
  side: "left" | "right";
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "absolute top-1/2 hidden size-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:ring-3 focus-visible:ring-turquoise-500/60 focus-visible:outline-none sm:inline-flex",
        side === "left" ? "left-3" : "right-3",
      )}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-6 fill-none stroke-current stroke-2"
      >
        <path
          d={side === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-6 fill-none stroke-current stroke-2">
    <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
  </svg>
);

const GridIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 fill-none stroke-current stroke-2">
    <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" strokeLinejoin="round" />
  </svg>
);
