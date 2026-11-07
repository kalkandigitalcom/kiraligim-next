"use client";

import { useEffect, useState } from "react";

import { moveId, sameOrder } from "@/lib/photo-order";

/**
 * Fotoğrafları sürükle-bırak ile sıralama (bağımlılıksız, Pointer Events).
 *
 * - Fare / kalem: basılı tutup 6 px'ten fazla hareket edince sürükleme başlar.
 * - Dokunmatik: parmağı ~250 ms basılı tutunca başlar (destekleyen cihazda kısa titreşir). Bu
 *   süreden önce parmak kayarsa normal sayfa kaydırması olur; sürükleme sırasında kaydırma
 *   engellenir.
 * - Sürüklenen kartın kopyası imleci/parmağı izler; liste canlı olarak yeniden dizilir, kartın
 *   yeni yeri kesikli çerçeveyle gösterilir. Ekran kenarına yaklaşınca sayfa kendiliğinden kayar.
 * - Escape veya sistem iptali (pointercancel) eski sıraya döner; değişiklik kaydedilmez.
 * - Klavye ve ekran okuyucu kullanıcıları için ← / → düğmeleri aynen kalır.
 *
 * Satır içi stil HTML'e yazılmaz (CSP style-src nonce): kopyanın konumu yalnız JavaScript ile
 * (CSSOM) ayarlanır; CSP buna takılmaz.
 */

const MOVE_SLOP = 6;
const LONG_PRESS_MS = 250;
const EDGE = 72;
const MAX_SCROLL_STEP = 18;

type Options = {
  ids: readonly string[];
  enabled: boolean;
  onDrop: (order: string[], movedId: string) => void;
  onAnnounce: (message: string) => void;
};

type Pending = {
  id: string;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  card: HTMLElement;
  timer: number | null;
};

type Active = {
  id: string;
  pointerId: number;
  original: string[];
  order: string[];
  ghost: HTMLElement;
  offsetX: number;
  offsetY: number;
  x: number;
  y: number;
  raf: number | null;
};

export type DragState = { id: string; order: string[] } | null;

type Shared = {
  ids: readonly string[];
  enabled: boolean;
  onDrop: Options["onDrop"];
  onAnnounce: Options["onAnnounce"];
  setDrag: (d: DragState) => void;
};

/** Tüm sürükleme mantığı: yalnız ref ve DOM ile çalışır, React render'ına bağlı değildir. */
function createController(setDrag: Shared["setDrag"]) {
  const shared: Shared = {
    ids: [],
    enabled: false,
    onDrop: () => {},
    onAnnounce: () => {},
    setDrag,
  };
  let list: HTMLOListElement | null = null;
  let pending: Pending | null = null;
  let active: Active | null = null;

  const position = (a: Active) => {
    a.ghost.style.left = `${a.x - a.offsetX}px`;
    a.ghost.style.top = `${a.y - a.offsetY}px`;
  };

  /** İmlecin altındaki kartın sıradaki yeri (sürüklenen kart dahil). */
  const indexAt = (a: Active): number | null => {
    if (!list) return null;
    for (const el of list.querySelectorAll<HTMLElement>("[data-photo-id]")) {
      const r = el.getBoundingClientRect();
      if (a.x >= r.left && a.x <= r.right && a.y >= r.top && a.y <= r.bottom) {
        const i = a.order.indexOf(el.dataset.photoId ?? "");
        return i >= 0 ? i : null;
      }
    }
    return null;
  };

  const reorderAt = (a: Active) => {
    const to = indexAt(a);
    if (to === null || a.order[to] === a.id) return;
    const next = moveId(a.order, a.id, to);
    if (sameOrder(next, a.order)) return;
    a.order = next;
    shared.setDrag({ id: a.id, order: next });
  };

  const autoScroll = () => {
    const a = active;
    if (!a) return;
    const h = window.innerHeight;
    let dy = 0;
    if (a.y < EDGE) dy = -Math.ceil(((EDGE - a.y) / EDGE) * MAX_SCROLL_STEP);
    else if (a.y > h - EDGE) dy = Math.ceil(((a.y - (h - EDGE)) / EDGE) * MAX_SCROLL_STEP);
    if (dy !== 0) {
      window.scrollBy(0, dy);
      reorderAt(a);
    }
    a.raf = window.requestAnimationFrame(autoScroll);
  };

  const cleanup = () => {
    if (pending?.timer) window.clearTimeout(pending.timer);
    pending = null;
    if (active) {
      if (active.raf) window.cancelAnimationFrame(active.raf);
      active.ghost.remove();
    }
    active = null;
    document.documentElement.classList.remove("photo-dragging");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
  };

  const begin = (p: Pending, x: number, y: number) => {
    const rect = p.card.getBoundingClientRect();
    const ghost = p.card.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-testid");
    ghost.removeAttribute("data-photo-id");
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("data-photo-ghost", "true");
    ghost.setAttribute("inert", "");
    // Sıra numarası kartın eski yerini gösterir; kopyada yanıltıcı olur.
    ghost.querySelectorAll("[data-photo-position]").forEach((el) => el.remove());
    Object.assign(ghost.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: "0",
      zIndex: "60",
      pointerEvents: "none",
      transform: "scale(1.04) rotate(-1.5deg)",
      boxShadow: "0 18px 40px rgba(15, 39, 56, 0.28)",
      opacity: "0.96",
    });
    document.body.appendChild(ghost);
    const order = [...shared.ids];
    const a: Active = {
      id: p.id,
      pointerId: p.pointerId,
      original: order,
      order,
      ghost,
      offsetX: p.startX - rect.left,
      offsetY: p.startY - rect.top,
      x,
      y,
      raf: null,
    };
    active = a;
    pending = null;
    position(a);
    document.documentElement.classList.add("photo-dragging");
    if (p.pointerType === "touch") navigator.vibrate?.(12);
    shared.setDrag({ id: a.id, order });
    shared.onAnnounce(
      `Fotoğraf ${order.indexOf(a.id) + 1} taşınıyor. Bırakmak istediğiniz yere sürükleyin; vazgeçmek için Escape.`,
    );
    a.raf = window.requestAnimationFrame(autoScroll);
  };

  const abort = (announce: boolean) => {
    const wasActive = !!active;
    cleanup();
    shared.setDrag(null);
    if (wasActive && announce) shared.onAnnounce("Sürükleme iptal edildi; sıra değişmedi.");
  };

  function onMove(e: PointerEvent) {
    const p = pending;
    if (p && e.pointerId === p.pointerId) {
      if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) <= MOVE_SLOP) return;
      // Dokunmatikte süre dolmadan kayma = sayfa kaydırma; sürükleme başlamaz.
      if (p.pointerType === "touch") cleanup();
      else begin(p, e.clientX, e.clientY);
      return;
    }
    const a = active;
    if (!a || e.pointerId !== a.pointerId) return;
    a.x = e.clientX;
    a.y = e.clientY;
    position(a);
    reorderAt(a);
  }

  function onUp(e: PointerEvent) {
    const a = active;
    if (!a) {
      if (pending?.pointerId === e.pointerId) cleanup();
      return;
    }
    if (e.pointerId !== a.pointerId) return;
    const { order, original, id } = a;
    cleanup();
    shared.setDrag(null);
    if (sameOrder(order, original)) {
      shared.onAnnounce("Sıra değişmedi.");
      return;
    }
    shared.onAnnounce(`Fotoğraf ${order.indexOf(id) + 1}. sıraya taşındı.`);
    shared.onDrop(order, id);
  }

  function onCancel(e: PointerEvent) {
    if (active ? e.pointerId === active.pointerId : pending?.pointerId === e.pointerId) {
      abort(true);
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || !active) return;
    e.preventDefault();
    e.stopPropagation();
    abort(true);
  }

  // Dokunmatik: sürükleme sırasında sayfa kaydırmasını engellemek için touchmove iptal
  // edilebilmeli. Tarayıcı bunu ancak dinleyici dokunma BAŞLAMADAN kayıtlı ve passive:false
  // ise dikkate alır; bu yüzden liste öğesine bağlanırken kaydedilir.
  const blockTouch = (e: TouchEvent) => {
    if (active) e.preventDefault();
  };

  return {
    setList(el: HTMLOListElement | null) {
      list?.removeEventListener("touchmove", blockTouch);
      list = el;
      el?.addEventListener("touchmove", blockTouch, { passive: false });
    },
    pointerDown(e: React.PointerEvent<HTMLElement>, id: string) {
      if (!shared.enabled || active || pending) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const card = e.currentTarget.closest<HTMLElement>("[data-photo-id]");
      if (!card) return;
      // Fare: metin seçimi ve tarayıcının yerel görsel sürüklemesi başlamasın.
      if (e.pointerType === "mouse") e.preventDefault();
      const p: Pending = {
        id,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        startX: e.clientX,
        startY: e.clientY,
        card,
        timer: null,
      };
      if (e.pointerType === "touch") {
        p.timer = window.setTimeout(() => {
          if (pending === p) begin(p, p.startX, p.startY);
        }, LONG_PRESS_MS);
      }
      pending = p;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
    },
    /** Render sonrası güncel değerler (effect içinden). */
    update(next: Omit<Shared, "setDrag">) {
      Object.assign(shared, next);
    },
    dispose: () => abort(false),
  };
}

export function usePhotoDrag({ ids, enabled, onDrop, onAnnounce }: Options) {
  const [drag, setDrag] = useState<DragState>(null);
  const [controller] = useState(() => createController(setDrag));
  useEffect(() => {
    controller.update({ ids, enabled, onDrop, onAnnounce });
  });
  useEffect(() => controller.dispose, [controller]);

  return {
    drag,
    listRef: controller.setList,
    onPointerDown: controller.pointerDown,
  };
}
