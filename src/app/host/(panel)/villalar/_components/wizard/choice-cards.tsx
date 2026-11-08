/**
 * Onay kutusu kartları (olanaklar, ev kuralları, fiyata dahil olanlar): geniş dokunma alanı,
 * seçilince vurgulu. Kutular kontrolsüzdür (defaultChecked): React 19 form eylemi sonrası formu
 * sıfırlar ve varsayılanları son değerlerden alır (Aşama 2 düzeltmesi).
 */
export function ChoiceCards({
  name,
  options,
  selected,
  labelledBy,
  group,
}: {
  name: string;
  options: readonly (readonly [string, string])[];
  selected: readonly string[];
  /** Grubun başlık öğesinin kimliği (ekran okuyucu). */
  labelledBy: string;
  /** Sayaç için grup anahtarı (data-group). */
  group?: string;
}) {
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      data-group={group}
      className="grid gap-2 sm:grid-cols-2"
    >
      {options.map(([key, label]) => (
        <label
          key={key}
          className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-border px-3 py-2 text-sm text-navy-900 transition-colors hover:bg-mist has-checked:border-turquoise-500 has-checked:bg-turquoise-50 has-disabled:cursor-default has-disabled:hover:bg-transparent has-disabled:has-checked:bg-turquoise-50"
        >
          <input
            type="checkbox"
            name={name}
            value={key}
            defaultChecked={selected.includes(key)}
            className="size-4 shrink-0 accent-navy-900"
          />
          {label}
        </label>
      ))}
    </div>
  );
}
