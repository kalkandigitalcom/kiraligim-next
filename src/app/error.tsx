"use client";

/** Beklenmeyen hatalar: kullanıcıya ayrıntı gösterilmez, yalnız hata kimliği (digest). */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-3 px-6 py-24">
      <h1 className="text-2xl font-bold">Bir şeyler ters gitti</h1>
      <p className="text-muted-foreground">
        Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.
        {error.digest ? ` Hata kodu: ${error.digest}` : null}
      </p>
      <button
        type="button"
        onClick={reset}
        className="w-fit rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Tekrar dene
      </button>
    </main>
  );
}
