import { cn } from "@/lib/utils";

type FieldProps = Omit<React.ComponentProps<"input">, "id"> & {
  id: string;
  label: string;
  hint?: React.ReactNode;
  error?: string | undefined;
  /** Etiketin sağında gösterilecek bağlantı vb. (ör. "Şifremi unuttum"). */
  labelAside?: React.ReactNode;
};

/** Etiket + giriş + yardım/hata metni. Hata, ekran okuyuculara aria-describedby ile bağlanır. */
export function Field({ id, label, hint, error, labelAside, className, ...input }: FieldProps) {
  const hintId = hint ? `${id}-ipucu` : undefined;
  const errorId = error ? `${id}-hata` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-navy-900">
          {label}
        </label>
        {labelAside}
      </div>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          "h-11 w-full rounded-lg border border-input bg-white px-3 text-[15px] text-navy-900 transition-colors placeholder:text-muted-foreground/70 focus-visible:border-turquoise-500 focus-visible:ring-3 focus-visible:ring-turquoise-500/25 focus-visible:outline-none disabled:opacity-60 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/20",
          className,
        )}
        {...input}
      />
      {error ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
