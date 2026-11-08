import { SECTION_IDS } from "@/config/marketing";
import { quoteMessage, quoteStay } from "@/lib/pricing";
import { cn } from "@/lib/utils";

import { BrowserFrame, DemoPhoto, PhoneFrame, ShotPicture } from "./frames";
import { HowItWorks } from "./how-it-works";
import { PriceCalculator } from "./price-calculator";
import { SAMPLE_PERIODS, SAMPLE_PROPERTY } from "./sample";
import { CheckList, Eyebrow, Section, SectionHeading } from "./section";
import { DEMO_PHOTOS, SHOTS } from "./shots";
import {
  CalendarLegend,
  MiniCalendar,
  PropertyCardMock,
  QuoteMock,
  SeasonTimeline,
  StatusChip,
  ToastMock,
  WhatsAppBubble,
} from "./ui-mock";

const SHORT_QUOTE = quoteStay("2027-06-14", "2027-06-19", SAMPLE_PERIODS);
const CROSS_QUOTE = quoteStay("2027-06-27", "2027-07-05", SAMPLE_PERIODS);

/* ------------------------------------------------------------------ */
/* Değer şeridi: yalnız bugün çalışan özellikler, yavaş kayan bant.     */
/* ------------------------------------------------------------------ */
const STRIP = [
  "Yarım gün takvim",
  "Onaylı · beklemede · blok",
  "Sezonluk fiyat dönemleri",
  "Haftalık fiyat blokları",
  "Temizlik ücreti kuralı",
  "Minimum konaklama uyarısı",
  "Tarih çakışma kontrolü",
  "WhatsApp'a hazır teklif",
  "Ön ödeme ve kalan tutar",
  "80 fotoğraflık galeri",
  "Telefonda da çalışır",
] as const;

export function ValueStrip() {
  return (
    <section aria-label="Öne çıkanlar" className="border-y border-navy-900/5 bg-white py-5">
      <div className="relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
        <ul className="site-marquee flex w-max gap-3">
          {[...STRIP, ...STRIP].map((t, i) => (
            <li
              key={i}
              aria-hidden={i >= STRIP.length}
              className="flex items-center gap-2 rounded-full border border-navy-900/10 bg-mist/60 px-4 py-2 text-sm font-semibold whitespace-nowrap text-navy-900/80"
            >
              <span aria-hidden="true" className="size-1.5 rounded-full bg-turquoise-500" />
              {t}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Sorun → çözüm                                                       */
/* ------------------------------------------------------------------ */
const NOTES = [
  { t: "12–19 Temmuz kimdeydi?", c: "rotate-[-5deg] bg-amber-100", p: "top-14 left-6" },
  { t: "Haziran haftalık fiyat kaçtı?", c: "rotate-[4deg] bg-white", p: "top-24 right-6" },
  {
    t: "Temizliği teklife ekledim mi?",
    c: "rotate-[-2deg] bg-turquoise-50",
    p: "bottom-24 left-10",
  },
  { t: "Ön ödeme geldi mi?", c: "rotate-[6deg] bg-amber-50", p: "bottom-6 right-10" },
] as const;

export function ProblemSolution() {
  return (
    <Section labelledBy="problem-title" className="overflow-hidden">
      <SectionHeading
        id="problem-title"
        eyebrow="Neden Kiralığım?"
        title="Defter, tablo ve mesajlar arasında kaybolmayın."
        lead="Rezervasyon bir yerde, fiyatlar başka yerde, hesap telefonun hesap makinesinde. Kiralığım hepsini aynı kurallarla, tek ekranda bir araya getirir."
      />
      <div className="mt-14 grid items-stretch gap-6 lg:grid-cols-2">
        <div
          data-reveal="left"
          className="relative min-h-[22rem] overflow-hidden rounded-3xl border border-dashed border-navy-900/15 bg-mist/50 p-6"
        >
          <p className="relative z-10 text-sm font-bold tracking-wide text-navy-900/45 uppercase">
            Önce
          </p>
          {NOTES.map((n) => (
            <p
              key={n.t}
              className={cn(
                "absolute max-w-[13rem] rounded-lg px-4 py-3 text-[15px] font-semibold text-navy-900/80 shadow-lg shadow-navy-900/10 transition-transform duration-500 hover:rotate-0",
                n.c,
                n.p,
              )}
            >
              {n.t}
            </p>
          ))}
        </div>
        <div
          data-reveal="right"
          className="flex flex-col gap-5 rounded-3xl bg-navy-900 p-6 text-white sm:p-8"
        >
          <p className="text-sm font-bold tracking-wide text-turquoise-500 uppercase">
            Kiralığım ile
          </p>
          <MiniCalendar rows={3} compact className="text-navy-900" />
          <CheckList
            invert
            items={[
              "Dolu, bekleyen ve kapalı tarihler tek takvimde.",
              "Fiyat kuralları bir kez girilir, her teklifte aynı uygulanır.",
              "Toplam, temizlik dahil kendiliğinden hesaplanır.",
            ]}
          />
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Nasıl çalışır                                                       */
/* ------------------------------------------------------------------ */
function VisualCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-3xl border border-navy-900/10 bg-mist site-grid p-5 sm:p-8",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function HowSection() {
  const message = quoteMessage(SHORT_QUOTE, SAMPLE_PROPERTY) ?? "";
  return (
    <Section id={SECTION_IDS.how} tone="mist" labelledBy="how-title">
      <SectionHeading
        id="how-title"
        eyebrow="Nasıl çalışır?"
        title="İlk mülkten ilk teklife, beş adımda."
        lead="Kurulum yok, uygulama indirme yok. Mülkünüzü ekleyin, fiyatlarınızı bir kez tanımlayın; gerisini panel sizin kurallarınızla yürütür."
      />
      <div className="mt-14 lg:mt-6">
        <HowItWorks
          steps={[
            {
              title: "Mülkünüzü oluşturun",
              text: "Kapasite, yatak odası, havuz ölçüleri, açıklama ve fotoğraflar. Mülkünüzün bilgileri tek kartta toplanır.",
              visual: (
                <VisualCard>
                  <PropertyCardMock className="mx-auto max-w-sm" />
                </VisualCard>
              ),
            },
            {
              title: "Fiyat dönemlerini belirleyin",
              text: "Sezon sezon gecelik ve haftalık fiyat, minimum konaklama ve temizlik ücreti. Dönemler çakışamaz; arada fiyatsız gün kalırsa panel gösterir.",
              visual: (
                <VisualCard>
                  <div className="rounded-2xl bg-white p-4 shadow-xl shadow-navy-900/10 sm:p-5">
                    <p className="mb-3 text-sm font-semibold text-navy-900">
                      Villa Defne · Fiyat dönemleri
                    </p>
                    <SeasonTimeline periods={SAMPLE_PERIODS} />
                  </div>
                </VisualCard>
              ),
            },
            {
              title: "Rezervasyonlarınızı yönetin",
              text: "Onaylı ve bekleyen rezervasyonlar, bakım için kapattığınız tarihler. Dolu bir tarihe ikinci kayıt girilemez.",
              visual: (
                <VisualCard>
                  <MiniCalendar rows={3} compact />
                  <ToastMock className="absolute right-4 bottom-4 w-64 sm:right-8 sm:bottom-8" />
                </VisualCard>
              ),
            },
            {
              title: "Konaklama tutarını hesaplatın",
              text: "Tarihleri seçtiğinizde her gece kendi döneminin fiyatıyla hesaplanır; haftalık bloklar ve temizlik ücreti kurallara göre eklenir.",
              visual: (
                <VisualCard>
                  <QuoteMock quote={CROSS_QUOTE} className="mx-auto max-w-sm" />
                </VisualCard>
              ),
            },
            {
              title: "Teklifi WhatsApp'tan paylaşın",
              text: "Döküm ve toplamla hazırlanan teklif metnini tek dokunuşla kopyalayın ya da WhatsApp'ta açın. Misafir bilgisi metne eklenmez.",
              visual: (
                <VisualCard className="flex justify-end">
                  <WhatsAppBubble text={message} className="max-w-sm" />
                </VisualCard>
              ),
            },
          ]}
        />
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Özellik bloğu iskeleti                                              */
/* ------------------------------------------------------------------ */
function FeatureBlock({
  id,
  eyebrow,
  title,
  lead,
  points,
  visual,
  reverse = false,
  tone = "white",
}: {
  id: string;
  eyebrow: string;
  title: string;
  lead: string;
  points: readonly React.ReactNode[];
  visual: React.ReactNode;
  reverse?: boolean;
  tone?: "white" | "mist";
}) {
  return (
    <Section tone={tone} labelledBy={id} className="overflow-hidden">
      <div className={cn("grid items-center gap-12 lg:grid-cols-2 lg:gap-20")}>
        <div className={cn("flex flex-col gap-6", reverse && "lg:order-2")}>
          <SectionHeading id={id} eyebrow={eyebrow} title={title} lead={lead} />
          <div data-reveal>
            <CheckList items={points} />
          </div>
        </div>
        <div className={cn("relative", reverse && "lg:order-1")}>{visual}</div>
      </div>
    </Section>
  );
}

export function FeaturesIntro() {
  return (
    <div id={SECTION_IDS.features} className="scroll-mt-20 bg-white pt-20 sm:pt-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionHeading
          id="features-title"
          align="center"
          eyebrow="Özellikler"
          title="Günlük kiralamanın her adımı için bir ekran."
          lead="Aşağıdaki görüntüler gerçek Kiralığım panelinden alınmıştır; içerikler örnek verilerdir."
        />
      </div>
    </div>
  );
}

/* Takvim */
export function FeatureCalendar() {
  return (
    <FeatureBlock
      id="feature-calendar"
      eyebrow="Rezervasyon takvimi"
      title="Doluluğunuzu bir bakışta görün."
      lead="Aylık takvimde her konaklama bir şerit. Şerit giriş günü öğleden sonra başlar, çıkış günü öğleden önce biter; aynı gün çıkış ve giriş yan yana, çakışmadan görünür."
      points={[
        <>
          <strong className="text-navy-900">Onaylı, beklemede, blok:</strong> renk ve desenle
          ayrışır, yalnız renge dayanmaz.
        </>,
        "Takvimde giriş ve çıkış gününe dokunarak yeni rezervasyon veya blok başlatın.",
        "Dolu tarihlere ikinci kayıt girilemez; çakışan tarihler açıkça gösterilir.",
        "Telefonda aynı takvim, ekrana sığacak biçimde.",
      ]}
      visual={
        <div className="relative pb-10 lg:pb-0">
          <div className="flex flex-col gap-3 rounded-3xl border border-navy-900/10 bg-mist/60 p-3 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 px-1">
              <p className="font-bold text-navy-900">Temmuz 2027</p>
              <CalendarLegend />
            </div>
            <MiniCalendar />
          </div>
          <div
            data-parallax="0.1"
            className="site-parallax absolute -right-2 -bottom-8 w-36 sm:-right-6 sm:w-44 lg:-right-10 lg:-bottom-16"
          >
            <div data-reveal="right">
              <PhoneFrame>
                <ShotPicture
                  shot={SHOTS.mobilTakvim}
                  alt="Kiralığım takvimi telefonda"
                  sizes="180px"
                />
              </PhoneFrame>
            </div>
          </div>
          <div
            data-reveal
            className="absolute -bottom-10 -left-2 hidden w-56 rounded-2xl border border-navy-900/10 bg-white p-3.5 shadow-xl shadow-navy-900/10 sm:block lg:-left-10"
          >
            <p className="text-xs font-semibold text-navy-900/60">Aynı gün çıkış ve giriş</p>
            <div className="mt-2 grid grid-cols-2 gap-0.5 rounded-lg border border-navy-900/10 p-1">
              <span className="h-6 rounded-l-md cal-confirmed text-center text-[10px] leading-6">
                Çıkış
              </span>
              <span className="h-6 rounded-r-md cal-pending text-center text-[10px] leading-6">
                Giriş
              </span>
            </div>
            <p className="mt-2 text-[11px] text-navy-900/55">
              Bir gün, iki yarım: sabah çıkan, öğleden sonra gelen.
            </p>
          </div>
        </div>
      }
    />
  );
}

/* Sezonluk fiyatlar */
export function FeatureRates() {
  return (
    <FeatureBlock
      id="feature-rates"
      tone="mist"
      reverse
      eyebrow="Sezonluk fiyatlar"
      title="Fiyatlarınızı bir kez tanımlayın."
      lead="Her dönem için gecelik ve haftalık fiyat, minimum konaklama ve temizlik ücreti. Başlangıç ve bitiş günleri dahildir: 1–30 Haziran, 30 gecedir."
      points={[
        "Haftalık fiyat, dönem içindeki 7 gecelik bloklara uygulanır; kalan geceler gecelikten.",
        "Dönemler kesişemez; araya fiyatsız gün kalırsa listede uyarı görürsünüz.",
        "Haftalık fiyat 7 gecelik toplamdan yüksekse panel sizi uyarır.",
        "Temizlik ücreti için 'şu geceden itibaren ücretsiz' sınırı.",
      ]}
      visual={
        <div className="relative">
          <div
            data-reveal="scale"
            className="rounded-3xl bg-white p-4 shadow-2xl shadow-navy-900/10 sm:p-6"
          >
            <div className="mb-4 flex items-center justify-between">
              <p className="font-bold text-navy-900">Villa Defne · 2027 sezonu</p>
              <span className="rounded-full bg-turquoise-50 px-2.5 py-0.5 text-xs font-semibold text-turquoise-700">
                TRY
              </span>
            </div>
            <SeasonTimeline periods={SAMPLE_PERIODS} />
          </div>
          <div
            data-parallax="0.08"
            className="site-parallax relative mx-auto -mt-6 w-[88%] sm:-mt-10"
          >
            <div
              data-reveal
              className="max-h-[26rem] overflow-hidden rounded-2xl border border-navy-900/10 bg-white [mask-image:linear-gradient(to_bottom,black_75%,transparent)] shadow-xl shadow-navy-900/10"
            >
              <ShotPicture
                shot={SHOTS.donemler}
                alt="Paneldeki fiyat dönemleri listesi"
                sizes="(min-width:1024px) 40vw, 90vw"
              />
            </div>
          </div>
        </div>
      }
    />
  );
}

/* Yıldız: canlı hesaplayıcı */
export function CalculatorSection() {
  return (
    <section
      id={SECTION_IDS.calculator}
      aria-labelledby="calc-title"
      className="relative scroll-mt-16 overflow-hidden bg-navy-900 site-glow-dark py-20 text-white sm:py-28 lg:py-32"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 site-grid-dark [mask-image:linear-gradient(to_bottom,black,transparent_85%)]"
      />
      <div className="relative mx-auto w-full max-w-7xl px-4 sm:px-6">
        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
          <SectionHeading
            id="calc-title"
            invert
            eyebrow="Akıllı fiyat hesaplama"
            title={
              <>
                Konaklama tutarını <span className="text-turquoise-500">siz hesaplamayın.</span>
              </>
            }
            lead="Tarihleri değiştirin, toplamın nasıl oluştuğunu satır satır görün. Bu hesaplayıcı, panelin kullandığı hesap motorunun aynısını örnek fiyatlarla çalıştırır."
          />
          <p data-reveal className="text-sm leading-relaxed text-white/55 lg:text-right">
            Örnek veriler kurgusaldır. Hesap tarayıcınızda yapılır; hiçbir bilgi gönderilmez veya
            kaydedilmez.
          </p>
        </div>
        <div data-reveal className="mt-12">
          <PriceCalculator />
        </div>
      </div>
    </section>
  );
}

/* Teklif */
export function FeatureQuote() {
  return (
    <FeatureBlock
      id="feature-quote"
      eyebrow="Teklif ve WhatsApp"
      title="Teklif metni kendiliğinden hazır."
      lead="Rezervasyon formunda tarihleri seçtiğiniz anda önerilen tutar dökümüyle görünür. Metni kopyalayın ya da doğrudan WhatsApp'ta açın."
      points={[
        "Döküm: dönem dönem geceler, haftalık bloklar, temizlik ücreti ve toplam.",
        "Tutar forma yalnız siz 'Bu tutarı kullan' dediğinizde aktarılır.",
        "Fiyatları değiştirmek kayıtlı rezervasyonların tutarını değiştirmez.",
        "Teklif metni misafirin adını veya telefonunu içermez.",
      ]}
      visual={
        <div className="relative sm:pb-20">
          <div data-reveal="scale">
            <BrowserFrame url="app.kiraligim.com/rezervasyonlar/yeni">
              <div className="bg-mist p-4 sm:p-8">
                <ShotPicture
                  shot={SHOTS.teklif}
                  alt="Paneldeki önerilen tutar kartı"
                  sizes="(min-width:1024px) 40vw, 90vw"
                  className="rounded-xl"
                />
              </div>
            </BrowserFrame>
          </div>
          <div
            data-parallax="0.1"
            className="site-parallax relative -mt-8 ml-auto w-[88%] sm:absolute sm:right-[-1rem] sm:-bottom-4 sm:mt-0 sm:w-80"
          >
            <div data-reveal="right">
              <WhatsAppBubble text={quoteMessage(SHORT_QUOTE, SAMPLE_PROPERTY) ?? ""} clamp />
            </div>
          </div>
        </div>
      }
    />
  );
}

/* Rezervasyonlar */
export function FeatureReservations() {
  return (
    <FeatureBlock
      id="feature-reservations"
      tone="mist"
      reverse
      eyebrow="Rezervasyon yönetimi"
      title="Her konaklama, tüm ayrıntılarıyla."
      lead="Misafir, kişi sayısı, kaynak, toplam tutar, ön ödeme ve kalan tutar. Rezervasyonlar yaklaşan, konaklayan, geçmiş ve iptal olarak ayrılır."
      points={[
        "Beklemede kaydı tek dokunuşla onaylayın; iptalde neden not edilir.",
        "Kaynak bilgisi: doğrudan, telefon, Airbnb, Booking.com.",
        "Bakım veya kişisel kullanım için tarih kapatma (blok).",
        "Misafir adına göre arama.",
      ]}
      visual={
        <div className="relative pt-8 pb-10">
          <div data-reveal="scale">
            <BrowserFrame url="app.kiraligim.com/rezervasyonlar">
              <ShotPicture
                shot={SHOTS.rezervasyonlar}
                alt="Paneldeki rezervasyon listesi"
                sizes="(min-width:1024px) 45vw, 95vw"
              />
            </BrowserFrame>
          </div>
          <div
            data-parallax="0.12"
            className="site-parallax absolute -top-2 -left-2 hidden w-60 sm:-left-8 sm:block"
          >
            <div
              data-reveal="left"
              className="rounded-2xl border border-navy-900/10 bg-white p-4 text-navy-900 shadow-xl shadow-navy-900/10"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold">Selin Aksoy</p>
                <StatusChip status="pending" />
              </div>
              <p className="mt-0.5 text-xs text-navy-900/55">12–19 Temmuz 2027 · 7 gece</p>
              <span className="mt-3 inline-flex rounded-md bg-navy-900 px-2.5 py-1 text-[11px] font-semibold text-white">
                Rezervasyonu onayla
              </span>
            </div>
          </div>
          <div
            data-parallax="0.06"
            className="site-parallax absolute right-0 -bottom-2 w-64 sm:-right-6"
          >
            <div
              data-reveal="right"
              className="rounded-2xl border border-navy-900/10 bg-white p-4 text-sm text-navy-900 shadow-xl shadow-navy-900/10"
            >
              <div className="flex justify-between">
                <span className="text-navy-900/60">Toplam</span>
                <span className="font-semibold tabular-nums">₺73.000,00</span>
              </div>
              <div className="mt-1 flex justify-between">
                <span className="text-navy-900/60">Ön ödeme</span>
                <span className="tabular-nums">₺20.000,00</span>
              </div>
              <div className="mt-2 flex justify-between border-t border-navy-900/10 pt-2">
                <span className="font-semibold">Kalan</span>
                <span className="font-bold text-turquoise-700 tabular-nums">₺53.000,00</span>
              </div>
            </div>
          </div>
        </div>
      }
    />
  );
}

/* Mülk yönetimi */
const MOSAIC = ["col-span-2 row-span-2", "", "", "", "", "col-span-2"] as const;

export function FeatureProperty() {
  return (
    <FeatureBlock
      id="feature-property"
      eyebrow="Mülk yönetimi"
      title="Mülkünüzün vitrini, düzenli bir galeri."
      lead="Fotoğrafları sürükleyip bırakın, sırayı ve kapak fotoğrafını belirleyin. Mülk bilgileri, havuz detayları ve açıklama aynı yerde."
      points={[
        "Mülk başına 80 fotoğraf; JPG, PNG ve WebP yüklenir, WebP olarak saklanır.",
        "Fotoğraflardaki konum (GPS) ve kamera bilgileri silinir.",
        "Kapasite, yatak ve banyo sayısı, havuz ölçüleri, belge numarası.",
        "Biçimli açıklama ve YouTube tanıtım videosu bağlantısı.",
      ]}
      visual={
        <div className="relative">
          <div data-reveal="scale" className="grid grid-cols-3 gap-2 sm:gap-3">
            {DEMO_PHOTOS.map((p, i) => (
              <figure
                key={p.name}
                className={cn(
                  "group relative overflow-hidden rounded-2xl bg-mist",
                  MOSAIC[i] || "",
                  i === 0 ? "aspect-auto" : "aspect-[3/2]",
                )}
              >
                <DemoPhoto
                  name={p.name}
                  alt={p.alt}
                  className="transition-transform duration-700 ease-out group-hover:scale-105"
                />
                <span className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-white/90 text-[11px] font-bold text-navy-900">
                  {i + 1}
                </span>
                {i === 0 ? (
                  <span className="absolute top-2 left-2 rounded-md bg-navy-900/85 px-2 py-0.5 text-[11px] font-semibold text-white">
                    Kapak
                  </span>
                ) : null}
              </figure>
            ))}
          </div>
          <div
            data-parallax="0.1"
            className="site-parallax absolute -bottom-12 -left-3 hidden w-64 sm:block lg:-left-10"
          >
            <div
              data-reveal="left"
              className="rounded-2xl border border-navy-900/10 bg-white p-4 text-navy-900 shadow-xl shadow-navy-900/10"
            >
              <p className="text-xs font-semibold text-navy-900/60">Havuz</p>
              <p className="mt-1 text-sm font-bold">Yüzme havuzu · 4 × 9 m</p>
              <p className="text-xs text-navy-900/60">Derinlik 1,60 m · Korunaklı</p>
              <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] font-medium">
                {["8 kişi", "4 yatak odası", "3 banyo"].map((t) => (
                  <span key={t} className="rounded-md bg-mist px-2 py-1">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <p className="mt-16 text-xs text-navy-900/45 sm:mt-6 sm:text-right">
            Görseller örnek illüstrasyonlardır.
          </p>
        </div>
      }
    />
  );
}

/* Telefon */
export function MobileSection() {
  return (
    <Section tone="navy" labelledBy="mobile-title" className="overflow-hidden site-glow-dark">
      <div className="grid items-center gap-14 lg:grid-cols-[1fr_1.1fr]">
        <div className="flex flex-col gap-6">
          <SectionHeading
            id="mobile-title"
            invert
            eyebrow="Her yerde"
            title="Misafir ararken panel cebinizde."
            lead="Kiralığım tarayıcıda çalışır; uygulama indirmeniz gerekmez. Takvime bakmak, tutar hesaplamak ve teklifi göndermek telefonda da birkaç dokunuş."
          />
          <div data-reveal>
            <CheckList
              invert
              items={[
                "Telefon, tablet ve bilgisayarda aynı hesap.",
                "Dokunmatik ekranda takvimden tarih seçimi.",
                "Teklifi doğrudan WhatsApp'ta açma.",
              ]}
            />
          </div>
        </div>
        <div className="relative mx-auto flex w-full max-w-md items-start justify-center gap-4 sm:gap-6">
          <div data-parallax="0.05" className="site-parallax w-1/2 pt-12">
            <div data-reveal="scale">
              <PhoneFrame className="border-white/10">
                <ShotPicture shot={SHOTS.mobilTakvim} alt="Telefonda takvim ekranı" sizes="220px" />
              </PhoneFrame>
            </div>
          </div>
          <div data-parallax="0.12" className="site-parallax w-1/2">
            <div data-reveal="scale" className="site-delay-2">
              <PhoneFrame className="border-white/10">
                <ShotPicture
                  shot={SHOTS.mobilTeklif}
                  alt="Telefonda önerilen tutar ve teklif"
                  sizes="220px"
                />
              </PhoneFrame>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

export { Eyebrow };
