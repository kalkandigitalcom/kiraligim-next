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

/**
 * Bir seçim grubunu topluca işaretleme / kaldırma (yalnız o grup: data-group). Kutular
 * kontrolsüz olduğu için DOM'da değiştirilir; kaydedilmemiş değişiklik uyarısı formu FormData ile
 * karşılaştırdığı için bunu da görür. `onDone` sayaç gibi gösterimleri günceller.
 */
export function BulkSelect({
  group,
  label,
  disabled,
  onDone,
}: {
  group: string;
  /** Ekran okuyucu için grup adı (ör. "Mutfak"). */
  label: string;
  disabled?: boolean;
  onDone?: () => void;
}) {
  const setAll = (btn: HTMLButtonElement, checked: boolean) => {
    const form = btn.closest("form") ?? document;
    form
      .querySelectorAll<HTMLInputElement>(`[data-group="${group}"] input[type="checkbox"]`)
      .forEach((i) => {
        if (!i.disabled) i.checked = checked;
      });
    onDone?.();
  };
  const cls =
    "inline-flex h-8 items-center rounded-lg border border-border px-2.5 text-xs font-semibold text-navy-900 transition-colors hover:bg-mist focus-visible:ring-3 focus-visible:ring-turquoise-500/30 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <div className="flex shrink-0 flex-wrap justify-end gap-1.5" data-testid={`bulk-${group}`}>
      <button
        type="button"
        className={cls}
        disabled={disabled}
        onClick={(e) => setAll(e.currentTarget, true)}
        data-testid={`select-all-${group}`}
      >
        Tümünü Seç<span className="sr-only">: {label}</span>
      </button>
      <button
        type="button"
        className={cls}
        disabled={disabled}
        onClick={(e) => setAll(e.currentTarget, false)}
        data-testid={`clear-all-${group}`}
      >
        Tümünü Kaldır<span className="sr-only">: {label}</span>
      </button>
    </div>
  );
}
