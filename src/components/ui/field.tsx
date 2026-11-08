import { cn } from "@/lib/utils";

type ShellProps = {
  id: string;
  label: string;
  hint?: React.ReactNode;
  error?: string | undefined;
  /** Etiketin sağında gösterilecek bağlantı vb. (ör. "Şifremi unuttum"). */
  labelAside?: React.ReactNode;
};

export const FIELD_CONTROL_CLASS =
  "w-full rounded-lg border border-input bg-white px-3 text-[15px] text-navy-900 transition-colors placeholder:text-muted-foreground/70 focus-visible:border-turquoise-500 focus-visible:ring-3 focus-visible:ring-turquoise-500/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-mist disabled:opacity-80 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/20";

function describedBy(id: string, hint: unknown, error: unknown) {
  return (
    [error ? `${id}-hata` : null, hint ? `${id}-ipucu` : null].filter(Boolean).join(" ") ||
    undefined
  );
}

/** Etiket + denetim + yardım/hata metni. Hata, ekran okuyuculara aria-describedby ile bağlanır. */
function Shell({
  id,
  label,
  hint,
  error,
  labelAside,
  children,
}: ShellProps & { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-navy-900">
          {label}
        </label>
        {labelAside}
      </div>
      {children}
      {error ? (
        <p id={`${id}-hata`} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={`${id}-ipucu`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

type FieldProps = Omit<React.ComponentProps<"input">, "id"> & ShellProps;

export function Field({ id, label, hint, error, labelAside, className, ...input }: FieldProps) {
  return (
    <Shell id={id} label={label} hint={hint} error={error} labelAside={labelAside}>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(FIELD_CONTROL_CLASS, "h-11", className)}
        {...input}
      />
    </Shell>
  );
}

type SelectFieldProps = Omit<React.ComponentProps<"select">, "id"> &
  ShellProps & { options: readonly { value: string; label: string }[]; placeholder?: string };

export function SelectField({
  id,
  label,
  hint,
  error,
  labelAside,
  className,
  options,
  placeholder,
  ...select
}: SelectFieldProps) {
  return (
    <Shell id={id} label={label} hint={hint} error={error} labelAside={labelAside}>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(FIELD_CONTROL_CLASS, "h-11 appearance-auto pr-8", className)}
        {...select}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Shell>
  );
}

type TextareaFieldProps = Omit<React.ComponentProps<"textarea">, "id"> & ShellProps;

export function TextareaField({
  id,
  label,
  hint,
  error,
  labelAside,
  className,
  ...textarea
}: TextareaFieldProps) {
  return (
    <Shell id={id} label={label} hint={hint} error={error} labelAside={labelAside}>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(FIELD_CONTROL_CLASS, "min-h-28 py-2.5 leading-relaxed", className)}
        {...textarea}
      />
    </Shell>
  );
}
