import { Logo } from "@/components/brand/logo";

/** Giriş, kayıt, doğrulama ve şifre sayfalarının ortak düzeni (app.<alan-adı>). */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh flex-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <aside className="hidden flex-col justify-between bg-navy-900 p-12 text-white lg:flex">
        <Logo variant="ters" className="h-9 w-auto self-start" />
        <div className="max-w-md">
          <h2 className="text-3xl leading-tight font-bold tracking-tight text-balance">
            Kiralık evlerinizi tek panelden yönetin.
          </h2>
          <p className="mt-4 leading-relaxed text-white/70">
            Villa ve kısa dönem kiralama işletmeleri için sade ve güvenli yönetim paneli.
          </p>
        </div>
        <p className="text-sm text-white/45">© {new Date().getFullYear()} Kiralığım</p>
      </aside>
      <main className="flex flex-col items-center justify-center bg-mist px-4 py-10 sm:px-8">
        <div className="w-full max-w-[400px]">
          <Logo className="mx-auto mb-8 h-8 w-auto lg:hidden" />
          {children}
        </div>
      </main>
    </div>
  );
}
