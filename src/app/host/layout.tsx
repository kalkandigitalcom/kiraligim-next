/** Ev sahibi paneli (app.<alan-adı>). Oturum kontrolü Faz 2'de eklenecek. */
export default function HostLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col">{children}</div>;
}
