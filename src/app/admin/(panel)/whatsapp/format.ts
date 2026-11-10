const FMT = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  dateStyle: "short",
  timeStyle: "short",
});

export const fmt = (d: Date | null) => (d ? FMT.format(d) : "—");

/** "5 dk önce" / tarih. */
export function ago(d: Date | null, now = Date.now()): string {
  if (!d) return "hiç";
  const m = Math.max(0, Math.round((now - d.getTime()) / 60000));
  if (m < 1) return "az önce";
  if (m < 60) return `${m} dk önce`;
  return fmt(d);
}
