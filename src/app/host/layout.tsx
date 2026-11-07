/**
 * Ev sahibi yüzeyi (app.<alan-adı>). (auth): giriş/kayıt/doğrulama/şifre sayfaları;
 * (panel): oturum gerektiren sayfalar (layout'ta requireUser).
 */
export default function HostLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col">{children}</div>;
}
