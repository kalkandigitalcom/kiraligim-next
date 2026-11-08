import type { Metadata } from "next";

import { SITE_COPY } from "@/config/marketing";
import { getBrand } from "@/config/brand";

import { FaqSection, FinalCta, PricingSection, RoadmapSection } from "./_components/closing";
import {
  CalculatorSection,
  FeatureCalendar,
  FeatureProperty,
  FeatureQuote,
  FeatureRates,
  FeatureReservations,
  FeaturesIntro,
  HowSection,
  MobileSection,
  ProblemSolution,
  ValueStrip,
} from "./_components/features";
import { Hero } from "./_components/hero";
import { siteLinks } from "./_components/site-links";

export function generateMetadata(): Metadata {
  return { title: { absolute: `${getBrand().name} · ${SITE_COPY.title}` } };
}

/**
 * Tanıtım ana sayfası. Ürün görüntüleri gerçek panelden (kurgusal verilerle) alınmıştır; hareketli
 * parçalar panelin sınıflarıyla kurulur ve tutarlar quoteStay ile hesaplanır. Yalnız bugün çalışan
 * özellikler anlatılır; geliştirilenler "Geliştiriliyor" bölümündedir.
 */
export default function SiteHomePage() {
  const { trial } = siteLinks();
  return (
    <>
      <Hero trial={trial} />
      <ValueStrip />
      <ProblemSolution />
      <HowSection />
      <FeaturesIntro />
      <FeatureCalendar />
      <FeatureRates />
      <CalculatorSection />
      <FeatureQuote />
      <FeatureReservations />
      <FeatureProperty />
      <MobileSection />
      <RoadmapSection />
      <PricingSection trial={trial} />
      <FaqSection />
      <FinalCta trial={trial} />
    </>
  );
}
