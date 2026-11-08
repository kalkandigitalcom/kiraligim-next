"use client";

import { type RefObject, useEffect, useRef } from "react";

import { setHistoryGuard } from "@/lib/history-guard";
import { UNSAVED_MESSAGE } from "@/lib/property-wizard";

/** Form içeriğinin karşılaştırılabilir özeti (dosya alanları adıyla). */
function snapshot(form: HTMLFormElement): string {
  return JSON.stringify(
    [...new FormData(form)].map(([k, v]) => [k, typeof v === "string" ? v : v.name]),
  );
}

type NavigationLike = { currentEntry?: { index: number } | null };

/** Geçerli geçmiş kaydının sırası (Navigation API); desteklenmiyorsa null. */
function entryIndex(): number | null {
  const nav = (window as unknown as { navigation?: NavigationLike }).navigation;
  const i = nav?.currentEntry?.index;
  return typeof i === "number" && i >= 0 ? i : null;
}

/**
 * Kaydedilmemiş değişiklik uyarısı. Form, sayfa açıldığındaki (kayıtlı) hâliyle karşılaştırılır;
 * kaydetme hatasından sonra da kullanıcının değerleri kayıtlı olmadığı için uyarı sürer.
 *  - Sekmeyi kapatma / yenileme / başka siteye gitme: tarayıcının kendi uyarısı (beforeunload).
 *  - Panel içi bağlantılar (adımlar, menü, Önceki): onay penceresi; vazgeçilirse sayfada kalınır.
 *  - Tarayıcının Geri / İleri tuşu (aynı belge içindeki geçmiş): onay penceresi. Tarayıcı adresi
 *    zaten değiştirmiştir; Next.js yönlendiricisinin popstate dinleyicisinden ÖNCE çalışılır
 *    (uygulama başlangıcında kurulan kapı, src/lib/history-guard.ts) ve olay ona ulaştırılmaz,
 *    böylece sayfa ve girilen değerler yerinde kalır.
 *      vazgeç → `history.go(fark)` ile aynı kayda dönülür; bu dönüşün popstate'i bir kez yutulur.
 *      onayla → aynı olay yönlendiriciye yeniden gönderilir; normal geri/ileri gezinmesi olur.
 *    Ek geçmiş kaydı eklenmez (ileri geçmişi silinmez). Fark, Navigation API'nin kayıt sırasından
 *    hesaplanır (uzun basışla birden çok adım atlama dahil); API yoksa tek adım geri varsayılır.
 * Kaydetme sürerken (form gönderildi, sonuç gelmedi) hiçbir uyarı çıkmaz: başarılı kayıtta sunucu
 * sonraki adıma yönlendirir ve bu yönlendirme bazı ortamlarda tam sayfa yüklemesiyle olur (ör.
 * yerel test sunucusu); kullanıcı az önce "Kaydet"e bastığı için "ayrılıyor musunuz?" sorulmamalı.
 * Sonuç hata ile dönerse (`result` değişir) koruma yeniden etkinleşir.
 */
export function useUnsavedGuard(
  formRef: RefObject<HTMLFormElement | null>,
  enabled: boolean,
  /** Form eyleminin son sonucu (useActionState durumu); değişince "kaydediliyor" biter. */
  result: unknown,
) {
  const savingRef = useRef(false);
  useEffect(() => {
    savingRef.current = false;
  }, [result]);

  useEffect(() => {
    const form = formRef.current;
    if (!enabled || !form) return;
    const baseline = snapshot(form);
    const dirty = () =>
      !savingRef.current && formRef.current ? snapshot(formRef.current) !== baseline : false;
    // Gönder düğmesi formun dışında da olsa (form özniteliği) submit olayı formda oluşur.
    const onSubmit = () => {
      savingRef.current = true;
    };

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirty()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement)) return;
      if (a.target && a.target !== "_self") return;
      if (a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      const here = new URL(window.location.href);
      // Aynı sayfadaki çapa bağlantısı (ör. "İçeriğe geç") form verisini kaybettirmez.
      if (url.pathname === here.pathname && url.search === here.search && url.hash) return;
      if (!dirty()) return;
      if (!window.confirm(UNSAVED_MESSAGE)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // Bu sayfanın geçmiş kaydı ve adresi (geri/ileri sonrası dönüş hedefi).
    const home = entryIndex();
    const homePath = window.location.pathname + window.location.search;
    let reverting = false;
    let revertTimer: ReturnType<typeof setTimeout> | undefined;
    let passing = false;
    const stopReverting = () => {
      reverting = false;
      clearTimeout(revertTimer);
    };
    const onPopState = (e: PopStateEvent) => {
      // Onaylanan gezinme: yeniden gönderilen olay yönlendiriciye olduğu gibi ulaşır.
      if (passing) return;
      // Vazgeçilince yapılan dönüş: yönlendirici görmez (sayfa zaten bu kayıttadır).
      if (reverting) {
        const at = entryIndex();
        if (home === null || at === null || at === home) {
          stopReverting();
          e.stopImmediatePropagation();
          return;
        }
        stopReverting();
      }
      // Aynı sayfa içindeki çapa (#) geçişi form verisini kaybettirmez.
      if (window.location.pathname + window.location.search === homePath) return;
      if (!dirty()) return;
      const to = entryIndex();
      const delta = home !== null && to !== null ? home - to : 1;
      if (delta === 0) return;
      e.stopImmediatePropagation();
      if (window.confirm(UNSAVED_MESSAGE)) {
        passing = true;
        try {
          window.dispatchEvent(new PopStateEvent("popstate", { state: e.state }));
        } finally {
          passing = false;
        }
        return;
      }
      reverting = true;
      // Güvenlik: dönüş olayı gelmezse bayrak sonraki gerçek gezinmeyi yutmasın.
      revertTimer = setTimeout(stopReverting, 3000);
      window.history.go(delta);
    };

    form.addEventListener("submit", onSubmit);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    // Uygulama başlangıcında kurulan kapı üzerinden: Next.js'in popstate dinleyicisinden önce.
    const releaseHistory = setHistoryGuard(onPopState);
    return () => {
      form.removeEventListener("submit", onSubmit);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      releaseHistory();
      stopReverting();
    };
  }, [formRef, enabled]);
}
