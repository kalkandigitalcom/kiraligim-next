export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-2 px-6 py-24">
      <p className="text-sm font-semibold text-accent">404</p>
      <h1 className="text-2xl font-bold">Sayfa bulunamadı</h1>
      <p className="text-muted-foreground">
        Aradığınız sayfa taşınmış ya da hiç var olmamış olabilir.
      </p>
    </main>
  );
}
