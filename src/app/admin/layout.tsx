/**
 * Super Admin paneli (admin.<alan-adı>). Ayrı alt alan adı, host-only çerez,
 * zorunlu 2FA ve isteğe bağlı IP izin listesi Faz 2–3'te eklenecek.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col">{children}</div>;
}
