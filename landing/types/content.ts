import type { LocaleCode } from "~/data/i18n";

export interface FeatureItem {
  id: string;
  title: string;
  description: string;
}

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
}

export interface HeroContent {
  title: string;
  subtitle: string;
}

export interface DownloadContent {
  title: string;
  note: string;
}

export interface PricingPlan {
  id: string;
  name: string;
  price: string;
  period: string;
  description: string;
  features: string[];
  highlighted?: boolean;
}

export interface TestimonialItem {
  id: string;
  name: string;
  role: string;
  text: string;
}

export interface LandingContent {
  hero: HeroContent;
  features: FeatureItem[];
  faq: FaqItem[];
  download: DownloadContent;
  pricing: PricingPlan[];
  testimonials: TestimonialItem[];
}

export type LocalizedContent = Record<LocaleCode, LandingContent>;
