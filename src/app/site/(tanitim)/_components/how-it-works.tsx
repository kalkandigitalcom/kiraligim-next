"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export type Step = { title: string; text: string; visual: React.ReactNode };

/**
 * "Nasıl çalışır": geniş ekranda solda adımlar, sağda yapışkan görsel; görünen adıma göre görsel
 * yumuşakça değişir. Dar ekranda her adımın görseli kendi altında (yapışkanlık yok).
 */
export function HowItWorks({ steps }: { steps: Step[] }) {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.step));
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
      <ol className="flex flex-col gap-6 lg:gap-0">
        {steps.map((s, i) => (
          <li
            key={s.title}
            ref={(el) => {
              refs.current[i] = el;
            }}
            data-step={i}
            className="flex flex-col gap-5 lg:min-h-[50vh] lg:justify-center"
          >
            <div
              data-active={active === i ? "" : undefined}
              className={cn(
                "flex gap-4 rounded-2xl border p-5 transition-all duration-500 motion-reduce:transition-none sm:p-6",
                active === i
                  ? "border-turquoise-500/40 bg-white shadow-lg shadow-navy-900/5"
                  : "border-transparent lg:opacity-45",
              )}
            >
              <span
                className={cn(
                  "flex size-10 shrink-0 items-center justify-center rounded-xl text-sm font-extrabold transition-colors",
                  active === i ? "bg-navy-900 text-white" : "bg-navy-900/8 text-navy-900",
                )}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <h3 className="text-xl font-bold tracking-tight text-navy-900 sm:text-2xl">
                  {s.title}
                </h3>
                <p className="mt-2 leading-relaxed text-navy-900/70">{s.text}</p>
              </div>
            </div>
            <div className="lg:hidden" data-reveal="scale">
              {s.visual}
            </div>
          </li>
        ))}
      </ol>
      <div className="hidden lg:block">
        <div className="sticky top-28 flex h-[min(34rem,70vh)] items-center">
          <div className="relative h-full w-full">
            {steps.map((s, i) => (
              <div
                key={s.title}
                aria-hidden={active !== i}
                className={cn(
                  "absolute inset-0 flex items-center justify-center transition-all duration-700 ease-out motion-reduce:transition-none",
                  active === i
                    ? "translate-y-0 scale-100 opacity-100"
                    : i < active
                      ? "pointer-events-none -translate-y-6 scale-95 opacity-0"
                      : "pointer-events-none translate-y-6 scale-95 opacity-0",
                )}
              >
                {s.visual}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
