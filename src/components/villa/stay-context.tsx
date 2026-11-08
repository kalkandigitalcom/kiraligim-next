"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

import type { AvailabilityWindow } from "@/lib/availability";
import {
  EMPTY_STAY,
  evaluateStay,
  selectStayDay,
  type StayEvaluation,
  type StaySelection,
  stayWhatsappText,
  whatsappLink,
} from "@/lib/public-stay";
import type { BusyRange } from "@/lib/public-villa";
import type { RatePeriod } from "@/lib/rate-meta";
import type { Currency } from "@/lib/reservation-meta";

/**
 * Villa sayfasındaki tarih seçimi (F2c). Durum yalnız tarayıcı belleğindedir: hiçbir şey
 * kaydedilmez, sunucuya gönderilmez. Fiyat mevcut quoteStay ile tarayıcıda hesaplanır.
 */
export type StayData = {
  villaName: string;
  /** Sayfa adresi; önizlemede adres kaydedilmemişse null. */
  pageUrl: string | null;
  /** İşletme WhatsApp numarası; önizlemede tanımlı değilse null (bağlantılar devre dışı). */
  whatsapp: string | null;
  maxGuests: number;
  busy: BusyRange[];
  window: AvailabilityWindow;
  rates: RatePeriod[];
  currency: Currency | null;
};

type StayState = StayData & {
  selection: StaySelection;
  evaluation: StayEvaluation;
  guests: number | null;
  setGuests: (n: number | null) => void;
  pick: (day: string) => void;
  clear: () => void;
  /** null: numara yok (yalnız önizlemede olabilir; public sayfa numarasız yayınlanmaz). */
  whatsappHref: string | null;
};

const Ctx = createContext<StayState | null>(null);

export function StayProvider({ data, children }: { data: StayData; children: React.ReactNode }) {
  const [selection, setSelection] = useState<StaySelection>(EMPTY_STAY);
  const [guests, setGuests] = useState<number | null>(null);
  const pick = useCallback(
    (day: string) => setSelection((s) => selectStayDay(s, day, data.busy, data.window)),
    [data.busy, data.window],
  );
  const clear = useCallback(() => setSelection(EMPTY_STAY), []);
  const evaluation = useMemo(
    () => evaluateStay(selection, data.busy, data.window, data.rates),
    [selection, data.busy, data.window, data.rates],
  );
  const whatsappHref = useMemo(
    () =>
      !data.whatsapp
        ? null
        : whatsappLink(
            data.whatsapp,
            stayWhatsappText({
              villaName: data.villaName,
              pageUrl: data.pageUrl,
              evaluation,
              guests,
            }),
          ),
    [data.whatsapp, data.villaName, data.pageUrl, evaluation, guests],
  );
  const value = useMemo(
    () => ({ ...data, selection, evaluation, guests, setGuests, pick, clear, whatsappHref }),
    [data, selection, evaluation, guests, pick, clear, whatsappHref],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStay(): StayState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStay yalnız StayProvider içinde kullanılır");
  return v;
}
