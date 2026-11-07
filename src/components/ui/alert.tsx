import { cn } from "@/lib/utils";

type AlertProps = {
  tone: "error" | "success" | "info";
  title?: string;
  children: React.ReactNode;
  className?: string;
};

const TONES = {
  error: "border-destructive/25 bg-destructive/5 text-destructive",
  success: "border-turquoise-500/30 bg-turquoise-50 text-turquoise-700",
  info: "border-border bg-mist text-navy-900",
} as const;

/** Form sonuç mesajı. Hata ve başarı ekran okuyuculara anında duyurulur. */
export function Alert({ tone, title, children, className }: AlertProps) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("rounded-lg border px-4 py-3 text-sm leading-relaxed", TONES[tone], className)}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      <div className={title ? "mt-0.5" : undefined}>{children}</div>
    </div>
  );
}
