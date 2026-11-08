import { cn } from "@/lib/utils";

/** Bölüm kabı: tutarlı genişlik ve dikey boşluk. */
export function Section({
  id,
  tone = "white",
  className,
  innerClassName,
  children,
  labelledBy,
}: {
  id?: string;
  tone?: "white" | "mist" | "navy";
  className?: string;
  innerClassName?: string;
  children: React.ReactNode;
  labelledBy?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn(
        "relative scroll-mt-20 py-20 sm:py-28 lg:py-32",
        tone === "mist" && "bg-mist",
        tone === "navy" && "bg-navy-900 text-white",
        className,
      )}
    >
      <div className={cn("mx-auto w-full max-w-7xl px-4 sm:px-6", innerClassName)}>{children}</div>
    </section>
  );
}

export function Eyebrow({
  children,
  invert = false,
}: {
  children: React.ReactNode;
  invert?: boolean;
}) {
  return (
    <p
      className={cn(
        "inline-flex items-center gap-2 text-sm font-bold tracking-wide",
        invert ? "text-turquoise-500" : "text-turquoise-700",
      )}
    >
      <span aria-hidden="true" className="h-0.5 w-6 rounded-full bg-current" />
      {children}
    </p>
  );
}

export function SectionHeading({
  id,
  eyebrow,
  title,
  lead,
  align = "left",
  invert = false,
  className,
}: {
  id: string;
  eyebrow?: string;
  title: React.ReactNode;
  lead?: React.ReactNode;
  align?: "left" | "center";
  invert?: boolean;
  className?: string;
}) {
  return (
    <div
      data-reveal
      className={cn(
        "flex max-w-3xl flex-col gap-4",
        align === "center" && "mx-auto items-center text-center",
        className,
      )}
    >
      {eyebrow ? <Eyebrow invert={invert}>{eyebrow}</Eyebrow> : null}
      <h2
        id={id}
        className="text-[2.25rem] leading-[1.05] font-extrabold tracking-[-0.03em] text-balance sm:text-5xl lg:text-[3.5rem]"
      >
        {title}
      </h2>
      {lead ? (
        <p
          className={cn(
            "text-lg leading-relaxed text-pretty",
            invert ? "text-white/70" : "text-navy-900/65",
          )}
        >
          {lead}
        </p>
      ) : null}
    </div>
  );
}

/** Onay işaretli madde listesi. */
export function CheckList({
  items,
  invert = false,
  className,
}: {
  items: readonly React.ReactNode[];
  invert?: boolean;
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-col gap-3", className)}>
      {items.map((t, i) => (
        <li
          key={i}
          className={cn(
            "flex gap-3 leading-relaxed",
            invert ? "text-white/80" : "text-navy-900/75",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
              invert
                ? "bg-turquoise-500/20 text-turquoise-500"
                : "bg-turquoise-50 text-turquoise-700",
            )}
          >
            <svg viewBox="0 0 16 16" className="size-3.5 fill-none stroke-current stroke-[2.4]">
              <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}
