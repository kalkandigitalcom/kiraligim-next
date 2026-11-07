/**
 * Fotoğraf sırası yardımcıları (bağımlılıksız; tarayıcı ve testler kullanır).
 */

/** `id`'yi listeden çıkarıp `toIndex` konumuna koyar. Yeni dizi döndürür; bulunamazsa aynısı. */
export function moveId(ids: readonly string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const to = Math.max(0, Math.min(ids.length - 1, toIndex));
  if (from === to) return [...ids];
  const next = ids.filter((x) => x !== id);
  next.splice(to, 0, id);
  return next;
}

export const sameOrder = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** `order`, `ids` ile aynı kümeyi içeriyorsa (yalnız sıra farklı) true. */
export function isPermutationOf(order: readonly string[], ids: readonly string[]): boolean {
  if (order.length !== ids.length) return false;
  const set = new Set(ids);
  return new Set(order).size === order.length && order.every((x) => set.has(x));
}
