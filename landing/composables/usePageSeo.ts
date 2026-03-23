import { computed } from "vue";
import { supportedLocales, defaultLocale } from "~/data/i18n";
import { getContent } from "~/data/content";
import type { LocaleCode } from "~/data/i18n";

type PageSeoImage = {
  url: string;
  width?: number;
  height?: number;
  type?: string;
  alt?: string;
};

type PageSeoOptions = {
  type?: "website" | "article";
  robots?: string;
  image?: PageSeoImage;
};

export const usePageSeo = (titleKey: string, descriptionKey: string, options: PageSeoOptions = {}) => {
  const { t, locale } = useI18n();
  const route = useRoute();
  const config = useRuntimeConfig();
  const siteUrl = config.public.siteUrl || "https://example.com";
  const siteName = (config as any)?.site?.name || "Claude Agent Teams";
  const switchLocale = useSwitchLocalePath();

  const title = computed(() => t(titleKey));
  const description = computed(() => t(descriptionKey));

  const canonicalPath = computed(() => route.path);
  const canonicalUrl = computed(() => `${siteUrl}${canonicalPath.value}`);

  const resolvedImage = computed<PageSeoImage>(() => {
    if (options.image) return options.image;
    return {
      url: "/og-image.png",
      width: 1200,
      height: 630,
      type: "image/png",
      alt: `${siteName} — AI agent orchestration`
    };
  });

  const resolvedImageUrl = computed(() => {
    // Если сборщик вернул относительный путь — сделаем абсолютный.
    const url = resolvedImage.value.url;
    return url.startsWith("http") ? url : new URL(url, siteUrl).toString();
  });

  useSeoMeta({
    title,
    description,
    ogTitle: title,
    ogDescription: description,
    ogType: options.type || "website",
    ogSiteName: siteName,
    ogUrl: canonicalUrl,
    ogImage: resolvedImageUrl,
    ogImageType: computed(() => resolvedImage.value.type) as any,
    ogImageWidth: computed(() => (resolvedImage.value.width ? String(resolvedImage.value.width) : undefined)),
    ogImageHeight: computed(() => (resolvedImage.value.height ? String(resolvedImage.value.height) : undefined)),
    ogImageAlt: computed(() => resolvedImage.value.alt),
    twitterCard: "summary_large_image",
    twitterTitle: title,
    twitterDescription: description,
    twitterImage: resolvedImageUrl,
    twitterImageAlt: computed(() => resolvedImage.value.alt),
    robots:
      options.robots ||
      "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1"
  });

  useHead(() => {
    const links: { rel: string; hreflang?: string; href: string }[] = supportedLocales.map((locale) => {
      const path = switchLocale(locale.code) || canonicalPath.value;
      return {
        rel: "alternate",
        hreflang: locale.code,
        href: `${siteUrl}${path}`
      };
    });

    const defaultPath = switchLocale(defaultLocale) || canonicalPath.value;
    links.push({ rel: "alternate", hreflang: "x-default", href: `${siteUrl}${defaultPath}` });
    links.push({ rel: "canonical", href: canonicalUrl.value });

    const jsonLd: any[] = [
      {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: siteName,
        url: siteUrl
      },
      {
        "@context": "https://schema.org",
        "@type": "Organization",
        name: siteName,
        url: siteUrl,
        logo: `${siteUrl}/favicon.ico`,
        sameAs: [
          `https://github.com/${config.public.githubRepo}`
        ]
      }
    ];

    // Для главной и страницы скачивания добавим более "вкусную" разметку.
    const isDownload = canonicalPath.value.endsWith("/download");
    const isHome = canonicalPath.value === "/";
    if (isHome || isDownload) {
      jsonLd.push({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: siteName,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Windows, macOS, Linux",
        description: description.value,
        url: canonicalUrl.value,
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD"
        },
        downloadUrl: config.public.githubReleasesUrl || `https://github.com/${config.public.githubRepo}/releases`
      });
    }

    // FAQ rich snippets — Google показывает их прямо в выдаче
    if (isHome) {
      const content = getContent(locale.value as LocaleCode);
      if (content.faq?.length) {
        jsonLd.push({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: content.faq.map((item) => ({
            "@type": "Question",
            name: item.question,
            acceptedAnswer: {
              "@type": "Answer",
              // HTML-теги из ответа убираем для JSON-LD
              text: item.answer.replace(/<[^>]*>/g, "")
            }
          }))
        });
      }
    }

    return {
      htmlAttrs: { lang: locale.value || "en" },
      link: links,
      meta: [
        { name: "author", content: "Claude Agent Teams" },
        { name: "application-name", content: siteName },
        { name: "apple-mobile-web-app-title", content: siteName },
        { name: "format-detection", content: "telephone=no" },
        { name: "theme-color", content: "#00f0ff" },
        { name: "keywords", content: "claude code, agent teams, AI agents, kanban board, code review, multi-agent orchestration, desktop app, free, open source" }
      ],
      script: jsonLd.map((item) => ({
        type: "application/ld+json",
        children: JSON.stringify(item)
      }))
    };
  });
};
