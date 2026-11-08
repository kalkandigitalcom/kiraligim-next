import { SECTION_IDS, SITE_COPY, type SignupCta } from "@/config/marketing";
import { quoteMessage, quoteStay } from "@/lib/pricing";
import { formatMoney } from "@/lib/reservation-meta";

import { BrowserFrame, PhoneFrame, ShotPicture } from "./frames";
import { SAMPLE_PERIODS, SAMPLE_PROPERTY } from "./sample";
import { SHOTS } from "./shots";
import { TrialLink } from "./trial-link";
import { QuoteMock, ToastMock, WhatsAppBubble } from "./ui-mock";

const HERO_QUOTE = quoteStay("2027-06-14", "2027-06-19", SAMPLE_PERIODS);

/**
 * Giriş bölümü: büyük tipografi; sağda gerçek panel takvimi ve üzerinde katmanlı, hareketli arayüz
 * kartları (önerilen tutar, kayıt bildirimi, WhatsApp teklifi). Katmanlar geniş ekranda kaydırma
 * ile hafif paralaks, işaretçiyle hafif eğim yapar; telefonda yalnız bir kart görünür.
 */
export function Hero({ trial }: { trial: SignupCta }) {
  const { hero } = SITE_COPY;
  const message = quoteMessage(HERO_QUOTE, SAMPLE_PROPERTY) ?? "";
  return (
    <section
      aria-labelledby="hero-title"
      className="relative isolate overflow-hidden bg-linear-to-b site-glow from-mist/60 to-white"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 site-grid [mask-image:radial-gradient(70%_60%_at_50%_30%,black,transparent)]"
      />
      <div className="mx-auto grid w-full max-w-7xl items-center gap-14 px-4 pt-12 pb-20 sm:px-6 sm:pt-16 lg:grid-cols-[0.92fr_1.08fr] lg:gap-12 lg:pt-20 lg:pb-28">
        <div className="flex flex-col gap-7">
          <p className="site-rise inline-flex items-center gap-2 self-start rounded-full border border-turquoise-500/30 bg-white/80 px-3.5 py-1.5 text-[13px] font-semibold text-turquoise-700 shadow-sm">
            <span aria-hidden="true" className="site-blink size-2 rounded-full bg-turquoise-500" />
            {hero.eyebrow}
          </p>
          <h1
            id="hero-title"
            className="site-rise site-d1 text-[3rem] leading-[0.98] font-extrabold tracking-[-0.035em] text-balance text-navy-900 sm:text-7xl lg:text-[4.6rem] xl:text-[5.4rem]"
          >
            {hero.titleLead}{" "}
            <span className="site-underline text-turquoise-700">{hero.titleAccent}</span>{" "}
            {hero.titleTail}
          </h1>
          <p className="site-rise site-d2 max-w-xl text-lg leading-relaxed text-pretty text-navy-900/70 sm:text-xl">
            {hero.lead}
          </p>
          <div className="site-rise site-d3 flex flex-col gap-3 sm:flex-row sm:items-center">
            <TrialLink cta={trial} size="lg" />
            <a
              href={`#${SECTION_IDS.calculator}`}
              className="group inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-navy-900/15 bg-white px-5 text-base font-semibold whitespace-nowrap text-navy-900 transition-colors hover:border-navy-900/30 hover:bg-mist"
            >
              {hero.secondaryCta}
              <span aria-hidden="true" className="transition-transform group-hover:translate-y-0.5">
                ↓
              </span>
            </a>
          </div>
          <ul className="site-rise site-d3 flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium text-navy-900/65">
            {hero.trust.map((t) => (
              <li key={t} className="flex items-center gap-2">
                <svg
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                  className="size-4 fill-none stroke-turquoise-500 stroke-[2.2]"
                >
                  <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t}
              </li>
            ))}
          </ul>
        </div>

        {/* Ürün kompozisyonu */}
        <div
          className="relative mx-auto hidden w-full max-w-2xl pb-10 sm:block lg:max-w-none lg:pb-0"
          aria-label="Kiralığım paneli: takvim ve fiyat teklifi"
          role="img"
        >
          <div className="site-pop site-d2">
            <div data-tilt className="site-tilt">
              <BrowserFrame url="app.kiraligim.com/takvim">
                <ShotPicture
                  shot={SHOTS.takvimYakin}
                  alt=""
                  sizes="(min-width: 1024px) 55vw, 100vw"
                  priority
                />
              </BrowserFrame>
            </div>
          </div>

          <div
            data-parallax="0.06"
            className="site-parallax absolute -bottom-14 -left-6 w-80 lg:-bottom-16 lg:-left-4"
          >
            <div className="site-pop site-d4">
              <div className="site-float">
                <QuoteMock quote={HERO_QUOTE} />
              </div>
            </div>
          </div>

          <div
            data-parallax="0.12"
            className="site-parallax absolute -top-8 -right-2 hidden w-72 sm:block lg:-right-6"
          >
            <div className="site-pop site-d5">
              <div className="site-float-slow">
                <ToastMock />
              </div>
            </div>
          </div>

          <div
            data-parallax="0.16"
            className="site-parallax absolute -right-8 -bottom-24 hidden w-72 xl:block"
          >
            <div className="site-pop site-d6">
              <WhatsAppBubble text={message} clamp />
            </div>
          </div>
        </div>

        {/* Telefon: gerçek mobil takvim + tutar kartı */}
        <div
          className="site-pop site-d3 relative mx-auto flex w-full max-w-sm items-end sm:hidden"
          aria-hidden="true"
        >
          <PhoneFrame className="w-[62%]">
            <ShotPicture shot={SHOTS.mobilTakvim} alt="" sizes="240px" priority />
          </PhoneFrame>
          <div className="absolute right-0 bottom-10 flex w-[52%] flex-col gap-3">
            <ToastMock className="p-3" />
            <div className="rounded-xl border border-navy-900/10 bg-white p-3 shadow-xl shadow-navy-900/10">
              <p className="text-[11px] font-semibold text-navy-900/60">
                Önerilen tutar · {HERO_QUOTE.nights} gece
              </p>
              <p className="mt-0.5 text-lg font-extrabold text-navy-900 tabular-nums">
                {formatMoney(HERO_QUOTE.totalMinor ?? 0, "TRY")}
              </p>
              <p className="text-[11px] text-navy-900/55">Temizlik ücreti dahil</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
