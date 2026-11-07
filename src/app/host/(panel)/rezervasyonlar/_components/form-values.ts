/**
 * Rezervasyon formu değer tipleri ve boş form. "use client" modülünden AYRI tutulur: sunucu
 * bileşenleri bu nesneleri okuyup birleştirir (istemci modülünden içe aktarılan değerler sunucuda
 * yalnız referanstır).
 */
export type ReservationFormValues = {
  kind: string;
  propertyId: string;
  checkIn: string;
  checkOut: string;
  status: string;
  source: string;
  guestName: string;
  guestPhone: string;
  guestEmail: string;
  adults: string;
  children: string;
  totalAmount: string;
  depositAmount: string;
  currency: string;
  note: string;
};

export const EMPTY_RESERVATION: ReservationFormValues = {
  kind: "reservation",
  propertyId: "",
  checkIn: "",
  checkOut: "",
  status: "confirmed",
  source: "direct",
  guestName: "",
  guestPhone: "",
  guestEmail: "",
  adults: "2",
  children: "0",
  totalAmount: "",
  depositAmount: "",
  currency: "TRY",
  note: "",
};

export type PropertyOption = { id: string; name: string; maxGuests: number };
