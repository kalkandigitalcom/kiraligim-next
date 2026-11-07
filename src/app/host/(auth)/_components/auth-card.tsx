import { Alert } from "@/components/ui/alert";

type AuthCardProps = {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

/** Kimlik sayfalarında başlık + beyaz kart + alt bağlantılar. */
export function AuthCard({ title, description, children, footer }: AuthCardProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8">
        <h1 className="text-2xl font-bold tracking-tight text-navy-900">{title}</h1>
        {description ? (
          <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
        <div className="mt-6">{children}</div>
      </div>
      {footer ? <div className="text-center text-sm text-muted-foreground">{footer}</div> : null}
    </div>
  );
}

/** Kimlik ortam değişkenleri eksikken gösterilir (sahte form yerine). */
export function AuthUnavailable() {
  return (
    <AuthCard title="Giriş geçici olarak kullanılamıyor">
      <Alert tone="info">Giriş sistemi şu an hizmet dışı. Lütfen daha sonra tekrar deneyin.</Alert>
    </AuthCard>
  );
}

/** Yerel geliştirmede e-posta gönderilmez; kullanıcıya bunu açıkça söyler. */
export function DevEmailNotice({ delivery }: { delivery: "resend" | "log" | "memory" }) {
  if (delivery === "resend") return null;
  return (
    <Alert tone="info" title="Geliştirme ortamı">
      E-posta gönderilmez; bağlantı sunucu log&apos;una yazılır (EMAIL_TRANSPORT={delivery}).
    </Alert>
  );
}
