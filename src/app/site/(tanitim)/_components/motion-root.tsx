"use client";

import { useEffect } from "react";

/**
 * Tanıtım sitesinin tek hareket betiği (DOM'a satır içi stil yazmaz; yalnız sınıf, veri özniteliği
 * ve CSSOM özel değişkenleri — CSP'ye tabi değildir).
 *  - [data-reveal]: görünür alana girince "is-in" (bir kez). Hareket azaltma tercihinde hiç gizlenmez.
 *  - [data-parallax="0.08"]: kaydırmaya göre --py (yalnız ≥1024 px ve hassas işaretçi).
 *  - [data-tilt]: işaretçiye göre --rx/--ry (aynı koşullar).
 *  - html[data-scrolled]: üst bar gölgesi.
 */
export function MotionRoot() {
  useEffect(() => {
    const root = document.documentElement;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rich = window.matchMedia("(min-width: 1024px) and (pointer: fine)").matches && !reduce;
    const cleanups: (() => void)[] = [];

    const onScrollFlag = () => {
      if (window.scrollY > 8) root.setAttribute("data-scrolled", "");
      else root.removeAttribute("data-scrolled");
    };
    onScrollFlag();
    window.addEventListener("scroll", onScrollFlag, { passive: true });
    cleanups.push(() => window.removeEventListener("scroll", onScrollFlag));

    if (!reduce && "IntersectionObserver" in window) {
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              e.target.classList.add("is-in");
              io.unobserve(e.target);
            }
          }
        },
        { rootMargin: "0px 0px -12% 0px", threshold: 0.12 },
      );
      const targets = document.querySelectorAll("[data-reveal]");
      // Görünür alanda zaten olanlar gizlenmeden işaretlenir (yanıp sönme olmasın).
      const vh = window.innerHeight;
      targets.forEach((el) => {
        if (el.getBoundingClientRect().top < vh * 0.9) el.classList.add("is-in");
        else io.observe(el);
      });
      root.classList.add("motion-ok");
      cleanups.push(() => io.disconnect());
    }

    if (rich) {
      const layers = Array.from(document.querySelectorAll<HTMLElement>("[data-parallax]"));
      let frame = 0;
      const update = () => {
        frame = 0;
        const vh = window.innerHeight;
        for (const el of layers) {
          const r = el.getBoundingClientRect();
          if (r.bottom < -200 || r.top > vh + 200) continue;
          const k = Number(el.dataset.parallax) || 0;
          const center = r.top + r.height / 2 - vh / 2;
          el.style.setProperty("--py", `${(-center * k).toFixed(1)}px`);
        }
      };
      const onScroll = () => {
        if (!frame) frame = requestAnimationFrame(update);
      };
      update();
      window.addEventListener("scroll", onScroll, { passive: true });
      cleanups.push(() => window.removeEventListener("scroll", onScroll));

      for (const el of document.querySelectorAll<HTMLElement>("[data-tilt]")) {
        const move = (ev: PointerEvent) => {
          const r = el.getBoundingClientRect();
          const x = (ev.clientX - r.left) / r.width - 0.5;
          const y = (ev.clientY - r.top) / r.height - 0.5;
          el.style.setProperty("--ry", `${(x * 5).toFixed(2)}deg`);
          el.style.setProperty("--rx", `${(-y * 4).toFixed(2)}deg`);
        };
        const leave = () => {
          el.style.setProperty("--ry", "0deg");
          el.style.setProperty("--rx", "0deg");
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerleave", leave);
        cleanups.push(() => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerleave", leave);
        });
      }
    }
    return () => cleanups.forEach((c) => c());
  }, []);
  return null;
}
