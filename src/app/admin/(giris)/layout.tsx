import { Logo } from "@/components/brand/logo";

/** Super Admin giriş sayfalarının düzeni (admin.<alan-adı>). İşletme girişinden ayrıdır. */
export default function AdminAuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-1 flex-col items-center justify-center bg-navy-900 px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <Logo variant="ters" className="h-8 w-auto" />
          <p className="text-sm font-medium tracking-wide text-white/60 uppercase">
            Platform yönetimi
          </p>
        </div>
        <div className="rounded-2xl bg-white p-6 shadow-xl sm:p-8">{children}</div>
      </div>
    </main>
  );
}
