/* eslint-disable @next/next/no-img-element -- next/image satır içi style ekler; CSP (style-src nonce) bunu engeller. Logo küçük ve önceden boyutlandırılmış. */

type LogoProps = {
  /** "koyu": açık zemin üzerinde lacivert logo; "ters": koyu zemin üzerinde beyaz logo. */
  variant?: "koyu" | "ters";
  className?: string;
  alt?: string;
};

/** Kiralığım logosu (public/brand). Oran 1416×298. */
export function Logo({ variant = "koyu", className, alt = "Kiralığım" }: LogoProps) {
  const src = variant === "ters" ? "/brand/kiraligim-logo-ters.png" : "/brand/kiraligim-logo.png";
  return <img src={src} alt={alt} width={1416} height={298} className={className} />;
}
