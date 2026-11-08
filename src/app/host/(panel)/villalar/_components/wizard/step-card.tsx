import { cn } from "@/lib/utils";

type Props = {
  /** Başlık kimliği (bölüm adı ekran okuyucuda bu başlıktan okunur). */
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
};

/** Sihirbazda bir bilgi grubu: başlık, kısa açıklama ve alanlar. */
export function StepCard({ id, title, description, icon, aside, className, children }: Props) {
  return (
    <section
      aria-labelledby={id}
      className={cn(
        "flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6",
        className,
      )}
      data-testid={`card-${id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {icon ? (
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-turquoise-50 text-turquoise-700"
            >
              {icon}
            </span>
          ) : null}
          <div className="min-w-0">
            <h3 id={id} className="text-base font-semibold text-navy-900">
              {title}
            </h3>
            {description ? (
              <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}
