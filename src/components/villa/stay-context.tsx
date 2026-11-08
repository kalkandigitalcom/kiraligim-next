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
import { clampGuests, defaultGuests } from "@/lib/reservation-request";
import type { RatePeriod } from "@/lib/rate-meta";
import type { Currency } from "@/lib/reservation-meta";

/**
 * Villa sayfasındaki tarih ve kişi seçimi (F2c, F3). Tek durum: rezervasyon kartı (yan sütun /
 * mobil kart), sayfadaki takvim, fiyat hesaplayıcı, WhatsApp mesajı ve talep formu AYNI seçimi
 * kullanır; biri değişince hepsi güncellenir. Fiyat mevcut quoteStay ile tarayıcıda gösterim için
 * hesaplanır; talep gönderilirken sunucu yeniden hesaplar.
 */
export type StayData = {
  villaName: string;
  /** Sayfa adresi; önizlemede adres kaydedilmemişse null. */
  pageUrl: string | null;
  /** İşletme WhatsApp numarası; önizlemede tanımlı değilse null (bağlantılar devre dışı). */
  whatsapp: string | null;
  maxGuests: number;
  /** Sayfa adresi (talep için); önizlemede adres kaydedilmemişse null. */
  slug: string | null;
  /** Rezervasyon talebi gönderilebilir mi? Panel önizlemesinde false (yalnız görünüm). */
  requestEnabled: boolean;
  busy: BusyRange[];
  window: AvailabilityWindow;
  rates: RatePeriod[];
  currency: Currency | null;
};

type StayState = StayData & {
  selection: StaySelection;
  evaluation: StayEvaluation;
  /** Kişi sayısı: 1 … kapasite (varsayılan 2, kapasiteyle sınırlı). */
  guests: number;
  setGuests: (n: number) => void;
  pick: (day: string) => void;
  clear: () => void;
  /** null: numara yok (yalnız önizlemede olabilir; public sayfa numarasız yayınlanmaz). */
  whatsappHref: string | null;
};

const Ctx = createContext<StayState | null>(null);

export function StayProvider({ data, children }: { data: StayData; children: React.ReactNode }) {
  const [selection, setSelection] = useState<StaySelection>(EMPTY_STAY);
  const [guests, setGuestsRaw] = useState<number>(() => defaultGuests(data.maxGuests));
  const setGuests = useCallback(
    (n: number) => setGuestsRaw(clampGuests(n, data.maxGuests)),
    [data.maxGuests],
  );
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
    [data, selection, evaluation, guests, setGuests, pick, clear, whatsappHref],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStay(): StayState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStay yalnız StayProvider içinde kullanılır");
  return v;
}
