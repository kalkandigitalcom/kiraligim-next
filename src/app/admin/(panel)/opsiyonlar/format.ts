const FMT = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  dateStyle: "short",
  timeStyle: "short",
});

/** Zaman damgası (İstanbul). */
export const fmt = (d: Date | null) => (d ? FMT.format(d) : "—");

/** Takvim günü "2027-01-05" → "05.01.2027". */
export const day = (iso: string | null) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

export const range = (a: string | null, b: string | null) =>
  a && b ? `${day(a)} → ${day(b)}` : "—";

export const guests = (adults: number | null, children: number | null) =>
  adults === null && children === null
    ? "—"
    : `${adults ?? "?"} yetişkin${children ? ` + ${children} çocuk` : ""}`;
