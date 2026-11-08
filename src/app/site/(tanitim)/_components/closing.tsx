import {
  FAQ_ITEMS,
  PLAN_FEATURES,
  PRICE_NOTE,
  ROADMAP_ITEMS,
  SECTION_IDS,
  SITE_COPY,
  type SignupCta,
  TRIAL_DAYS,
} from "@/config/marketing";
import { cn } from "@/lib/utils";

import { CheckList, Section, SectionHeading } from "./section";
import { TrialLink } from "./trial-link";

/* Geliştiriliyor: yalnız yol haritası; çalışıyor gibi sunulmaz. */
export function RoadmapSection() {
  return (
    <Section labelledBy="roadmap-title">
      <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <SectionHeading
          id="roadmap-title"
          eyebrow="Geliştiriliyor"
          title="Sırada ne var?"
          lead="Aşağıdaki özellikler geliştirme aşamasındadır ve henüz panelde yoktur. Hazır olduklarında bu sayfada duyurulacak."
        />
        <ul className="grid gap-4 sm:grid-cols-2">
          {ROADMAP_ITEMS.map((r, i) => (
            <li
              key={r.title}
              data-reveal
              className={cn(
                "flex flex-col gap-2 rounded-2xl border border-dashed border-navy-900/20 bg-mist/40 p-5 transition-colors hover:border-turquoise-500/50 hover:bg-white",
                `site-delay-${i + 1}`,
              )}
            >
              <span className="self-start rounded-full bg-navy-900/8 px-2.5 py-0.5 text-xs font-semibold text-navy-900/70">
                Geliştiriliyor
              </span>
              <p className="font-bold text-navy-900">{r.title}</p>
              <p className="text-sm leading-relaxed text-navy-900/65">{r.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

/* Fiyatlandırma */
export function PricingSection({ trial }: { trial: SignupCta }) {
  return (
    <Section id={SECTION_IDS.pricing} tone="mist" labelledBy="pricing-title">
      <SectionHeading
        id="pricing-title"
        align="center"
        eyebrow="Fiyatlandırma"
        title={`${TRIAL_DAYS} gün ücretsiz deneyin, sonra karar verin.`}
        lead="Tüm özellikler deneme süresince açık. Kart bilgisi istenmez."
      />
      <div className="mx-auto mt-14 grid max-w-5xl gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <div
          data-reveal="scale"
          className="relative overflow-hidden rounded-3xl border border-navy-900/10 bg-white p-7 shadow-2xl shadow-navy-900/10 sm:p-10"
        >
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-1.5 bg-linear-to-r from-turquoise-700 via-turquoise-500 to-turquoise-700"
          />
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-bold tracking-wide text-turquoise-700 uppercase">
                Başlangıç
              </p>
              <p className="mt-1 text-2xl font-extrabold tracking-tight text-navy-900">
                Tek mülk için
              </p>
            </div>
            <span className="rounded-full bg-turquoise-50 px-3 py-1 text-sm font-bold text-turquoise-700">
              {TRIAL_DAYS} gün ücretsiz
            </span>
          </div>
          <div className="mt-6 rounded-2xl bg-mist px-5 py-4" data-testid="price-note">
            <p className="text-lg font-bold text-navy-900">{PRICE_NOTE}</p>
            <p className="mt-1 text-sm text-navy-900/60">Deneme süresince ücret alınmaz.</p>
          </div>
          <CheckList items={PLAN_FEATURES} className="mt-7 sm:grid sm:grid-cols-2 sm:gap-x-6" />
          <div className="mt-8 flex flex-col gap-2 sm:flex-row sm:items-center">
            <TrialLink cta={trial} size="lg" />
            {!trial.open ? (
              <p className="text-sm text-navy-900/60 sm:ml-3">
                Kayıtlar kısa süre içinde açılacak.
              </p>
            ) : null}
          </div>
        </div>
        <div
          data-reveal="right"
          className="flex flex-col gap-4 rounded-3xl bg-navy-900 p-7 text-white sm:p-8"
        >
          <p className="text-sm font-bold tracking-wide text-turquoise-500 uppercase">
            Deneme süresinde
          </p>
          <ol className="flex flex-col gap-5">
            {[
              ["Mülkünüzü ekleyin", "Bilgiler, fotoğraflar ve havuz detayları."],
              ["Fiyatlarınızı girin", "Sezon dönemleri, haftalık fiyat ve temizlik ücreti."],
              ["Rezervasyonlarınızı taşıyın", "Mevcut ve gelecek konaklamaları takvime işleyin."],
              ["İlk teklifinizi gönderin", "Tutarı hesaplatın, WhatsApp'tan paylaşın."],
            ].map(([t, d], i) => (
              <li key={t} className="flex gap-4">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-sm font-bold text-turquoise-500">
                  {i + 1}
                </span>
                <span>
                  <span className="block font-semibold">{t}</span>
                  <span className="text-sm text-white/60">{d}</span>
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-auto flex flex-wrap gap-2 border-t border-white/10 pt-5">
            {SITE_COPY.hero.trust.map((t) => (
              <span
                key={t}
                className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white/80"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}

/* SSS */
export function FaqSection() {
  return (
    <Section id={SECTION_IDS.faq} labelledBy="faq-title">
      <div className="grid gap-10 lg:grid-cols-[0.75fr_1.25fr] lg:gap-16">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <SectionHeading
            id="faq-title"
            eyebrow="Sık sorulan sorular"
            title="Merak ettikleriniz."
            lead="Kiralığım'ın bugün neler yaptığını ve neleri henüz yapmadığını açıkça yazdık."
          />
        </div>
        <div
          data-reveal
          className="flex flex-col divide-y divide-navy-900/10 rounded-3xl border border-navy-900/10 bg-white px-5 sm:px-7"
        >
          {FAQ_ITEMS.map((f) => (
            <details key={f.q} className="site-faq group py-1">
              <summary className="flex cursor-pointer items-center justify-between gap-4 rounded-lg py-4 text-left text-[17px] font-semibold text-navy-900 focus-visible:ring-3 focus-visible:ring-turquoise-500/40 focus-visible:outline-none">
                {f.q}
                <span
                  aria-hidden="true"
                  className="site-faq-icon flex size-8 shrink-0 items-center justify-center rounded-full bg-mist text-xl leading-none text-navy-900 transition-transform duration-300 group-hover:bg-turquoise-50"
                >
                  +
                </span>
              </summary>
              <p className="pr-10 pb-5 leading-relaxed text-navy-900/70">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}

/* Kapanış */
const BG_BARS = [
  "col-start-1 col-end-6",
  "col-start-7 col-end-12",
  "col-start-3 col-end-9",
  "col-start-10 col-end-15",
  "col-start-1 col-end-4",
  "col-start-5 col-end-11",
] as const;

export function FinalCta({ trial }: { trial: SignupCta }) {
  return (
    <section
      id={SECTION_IDS.trial}
      aria-labelledby="final-title"
      className="relative scroll-mt-16 overflow-hidden bg-navy-900 py-24 text-white sm:py-32"
    >
      <div aria-hidden="true" className="absolute inset-0 opacity-[0.14]">
        <div data-reveal className="flex h-full flex-col justify-between gap-5 px-4 py-8">
          {[0, 2].map((r) => (
            <div key={r} className="grid grid-cols-14 gap-3">
              {BG_BARS.slice(r * 2, r * 2 + 2).map((c, i) => (
                <span
                  key={c}
                  className={cn(
                    "site-draw h-10 rounded-xl",
                    c,
                    i === 0 && r === 2 ? "cal-pending" : "bg-turquoise-500",
                    `site-delay-${r * 2 + i + 1}`,
                  )}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="relative mx-auto flex w-full max-w-4xl flex-col items-center gap-8 px-4 text-center sm:px-6">
        <p data-reveal className="text-sm font-bold tracking-wide text-turquoise-500 uppercase">
          {SITE_COPY.slogan}
        </p>
        <h2
          id="final-title"
          data-reveal
          className="text-[2.6rem] leading-[1.02] font-extrabold tracking-[-0.035em] text-balance sm:text-6xl lg:text-7xl"
        >
          Takvim, fiyat ve rezervasyon. Hepsi tek panelde.
        </h2>
        <p data-reveal className="max-w-2xl text-lg text-white/70">
          {trial.open
            ? `${TRIAL_DAYS} gün boyunca tüm özellikleri ücretsiz kullanın. Kart bilgisi gerekmez.`
            : SITE_COPY.trialSoonText}
        </p>
        <div data-reveal className="flex flex-col items-center gap-3 sm:flex-row">
          {trial.open ? (
            <TrialLink cta={trial} size="lg" tone="light" />
          ) : (
            <span
              data-testid="signup-soon"
              className="inline-flex h-12 items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-6 text-base font-semibold"
            >
              <span
                aria-hidden="true"
                className="site-blink size-2 rounded-full bg-turquoise-500"
              />
              Kayıtlar çok yakında açılıyor
            </span>
          )}
          <a
            href={`#${SECTION_IDS.calculator}`}
            className="inline-flex h-12 items-center rounded-xl px-6 text-base font-semibold text-white/85 underline-offset-4 hover:text-white hover:underline"
          >
            Fiyat hesaplamayı deneyin
          </a>
        </div>
      </div>
    </section>
  );
}
