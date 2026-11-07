"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import type { ReservationKind } from "@/lib/reservation-meta";

import { searchReservationsAction } from "../actions";
import { ReservationCard, type ReservationCardData } from "./reservation-card";

type ViewKey = "upcoming" | "current" | "past" | "cancelled";

type Props = {
  view: ViewKey;
  viewLabel: string;
  kind: ReservationKind | undefined;
  propertyId: string | undefined;
  showProperty: boolean;
  /** Arama yokken gösterilen, sunucuda üretilmiş liste ve sayfalama. */
  children: React.ReactNode;
};

type Active = {
  query: string;
  page: number;
  items: ReservationCardData[];
  hasMore: boolean;
};

/**
 * Misafir adına arama — GİZLİLİK: terim yalnız bu bileşenin yerel state'inde tutulur ve server
 * action ile (POST gövdesinde) gönderilir. URL'ye, sorgu dizesine veya tarayıcı geçmişine
 * yazılmaz; girdi alanının `name` özniteliği yoktur (JavaScript yüklenmeden gönderilse bile
 * adres çubuğuna eklenmez). Görünüm, tür ve mülk filtreleri URL'de kalır (kişisel veri değil);
 * filtre değişince etkin arama yeni filtrelerle yeniden çalışır.
 */
export function ReservationSearch({
  view,
  viewLabel,
  kind,
  propertyId,
  showProperty,
  children,
}: Props) {
  const hydrated = useHydrated();
  const [input, setInput] = useState("");
  const [active, setActive] = useState<Active | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const filtersKey = `${view}|${kind ?? ""}|${propertyId ?? ""}`;
  const lastFilters = useRef(filtersKey);

  const run = (query: string, page: number) => {
    startTransition(async () => {
      const r = await searchReservationsAction({ view, kind, propertyId, query, page });
      if (r.ok) {
        setError(null);
        setActive({ query, page: r.page, items: r.items, hasMore: r.hasMore });
      } else {
        setError(r.error);
      }
    });
  };

  // Sekme / tür / mülk değişince etkin arama yeni filtrelerle 1. sayfadan yeniden çalışır.
  useEffect(() => {
    if (lastFilters.current === filtersKey) return;
    lastFilters.current = filtersKey;
    if (active) run(active.query, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  const clear = () => {
    setInput("");
    setActive(null);
    setError(null);
  };

  return (
    <>
      <form
        role="search"
        aria-label="Rezervasyonlarda ara"
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          const q = input.trim();
          if (q) run(q, 1);
          else clear();
        }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor="ara" className="text-sm font-medium text-navy-900">
            Misafir adı
          </label>
          {/* name yok: değer hiçbir koşulda sorgu dizesine eklenmez. */}
          <input
            id="ara"
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={120}
            autoComplete="off"
            placeholder="Ada göre ara"
            className="h-11 w-full rounded-lg border border-input bg-white px-3 text-[15px] text-navy-900 placeholder:text-muted-foreground/70 focus-visible:border-turquoise-500 focus-visible:ring-3 focus-visible:ring-turquoise-500/25 focus-visible:outline-none"
          />
        </div>
        <div className="flex gap-2">
          <Button
            type="submit"
            variant="secondary"
            className="flex-1 sm:flex-none"
            disabled={!hydrated || pending}
          >
            {pending ? "Aranıyor…" : "Ara"}
          </Button>
          {active || input ? (
            <Button variant="ghost" className="flex-1 sm:flex-none" onClick={clear}>
              Temizle
            </Button>
          ) : null}
        </div>
      </form>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {active ? (
        <section aria-label="Arama sonuçları" className="flex flex-col gap-3" aria-busy={pending}>
          <p className="text-sm text-muted-foreground" role="status" data-testid="search-status">
            {active.items.length === 0
              ? `"${active.query}" için sonuç bulunamadı.`
              : `"${active.query}" için ${viewLabel.toLocaleLowerCase("tr-TR")} kayıtlar`}
          </p>
          {active.items.length > 0 ? (
            <ul aria-label="Arama sonuçları listesi" className="flex flex-col gap-3">
              {active.items.map((r) => (
                <li key={r.id}>
                  <ReservationCard r={r} showProperty={showProperty} />
                </li>
              ))}
            </ul>
          ) : null}
          {active.page > 1 || active.hasMore ? (
            <nav aria-label="Arama sayfaları" className="flex items-center justify-between gap-3">
              {active.page > 1 ? (
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => run(active.query, active.page - 1)}
                >
                  ← Önceki
                </Button>
              ) : (
                <span />
              )}
              <span className="text-sm text-muted-foreground">Sayfa {active.page}</span>
              {active.hasMore ? (
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => run(active.query, active.page + 1)}
                >
                  Sonraki →
                </Button>
              ) : (
                <span />
              )}
            </nav>
          ) : null}
        </section>
      ) : (
        children
      )}
    </>
  );
}
