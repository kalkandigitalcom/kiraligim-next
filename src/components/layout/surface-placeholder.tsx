type Props = { brandName: string; title: string; description: string };

/** Faz 1 yer tutucusu: her yüzeyin doğru alan adından açıldığını gösterir. */
export function SurfacePlaceholder({ brandName, title, description }: Props) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-3 px-6 py-24">
      <p className="text-sm font-semibold tracking-wide text-accent uppercase">{brandName}</p>
      <h1 className="text-3xl font-extrabold tracking-tight text-balance">{title}</h1>
      <p className="text-muted-foreground">{description}</p>
    </main>
  );
}
