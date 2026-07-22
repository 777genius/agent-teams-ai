import { computed } from 'vue';
import { supportedLocales, defaultLocale, getLocaleMeta } from '~/data/i18n';
import { getContent } from '~/data/content';
import type { LocaleCode } from '~/data/i18n';

type PageSeoImage = {
  url: string;
  width?: number;
  height?: number;
  type?: string;
  alt?: string;
};

type PageSeoOptions = {
  type?: 'website' | 'article';
  robots?: string;
  image?: PageSeoImage;
};

export const usePageSeo = (
  titleKey: string,
  descriptionKey: string,
  options: PageSeoOptions = {},
) => {
  const { t, locale } = useI18n();
  const route = useRoute();
  const config = useRuntimeConfig();
  const siteUrl = ((config.public.siteUrl as string) || 'https://example.com').replace(/\/+$/, '');
  const siteName = 'Agent Teams';
  const switchLocale = useSwitchLocalePath();

  const title = computed(() => t(titleKey));
  const description = computed(() => t(descriptionKey));

  const canonicalPath = computed(() => route.path);
  const toSiteUrl = (pathOrUrl: string) => {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    const path = pathOrUrl === '/' ? '/' : `/${pathOrUrl.replace(/^\/+/, '')}`;
    return `${siteUrl}${path}`;
  };
  const canonicalUrl = computed(() => toSiteUrl(canonicalPath.value));

  const resolvedImage = computed<PageSeoImage>(() => {
    if (options.image) return options.image;
    return {
      url: '/og-image-agent-teams-v6.png',
      width: 1200,
      height: 630,
      type: 'image/png',
      alt: `${siteName} - AI agent orchestration`,
    };
  });

  const resolvedImageUrl = computed(() => {
    // Если сборщик вернул относительный путь - сделаем абсолютный.
    const url = resolvedImage.value.url;
    return toSiteUrl(url);
  });

  useSeoMeta({
    title,
    description,
    ogTitle: title,
    ogDescription: description,
    ogType: options.type || 'website',
    ogSiteName: siteName,
    ogUrl: canonicalUrl,
    ogImage: resolvedImageUrl,
    ogImageType: computed(() => resolvedImage.value.type),
    ogImageWidth: computed(() =>
      resolvedImage.value.width ? String(resolvedImage.value.width) : undefined,
    ),
    ogImageHeight: computed(() =>
      resolvedImage.value.height ? String(resolvedImage.value.height) : undefined,
    ),
    ogImageAlt: computed(() => resolvedImage.value.alt),
    twitterCard: 'summary_large_image',
    twitterTitle: title,
    twitterDescription: description,
    twitterImage: resolvedImageUrl,
    twitterImageAlt: computed(() => resolvedImage.value.alt),
    robots:
      options.robots ||
      'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1',
  });

  useHead(() => {
    const currentLocale = getLocaleMeta(locale.value as LocaleCode);
    const links: { rel: string; hreflang?: string; href: string }[] = supportedLocales.map(
      (locale) => {
        const path = switchLocale(locale.code) || canonicalPath.value;
        return {
          rel: 'alternate',
          hreflang: locale.iso,
          href: toSiteUrl(path),
        };
      },
    );

    const defaultPath = switchLocale(defaultLocale) || canonicalPath.value;
    links.push({ rel: 'alternate', hreflang: 'x-default', href: toSiteUrl(defaultPath) });
    links.push({ rel: 'canonical', href: canonicalUrl.value });

    const ogLocale = currentLocale.iso.replace('-', '_');
    const ogAlternateLocales = supportedLocales
      .filter((locale) => locale.iso !== currentLocale.iso)
      .map((locale) => locale.iso.replace('-', '_'));

    const normalizedPath =
      canonicalPath.value === '/' ? '/' : canonicalPath.value.replace(/\/+$/, '');
    const localizedHomePath = currentLocale.code === defaultLocale ? '/' : `/${currentLocale.code}`;
    const isHome = normalizedPath === localizedHomePath;
    const isDownload = normalizedPath.endsWith('/download');
    const organizationId = `${siteUrl}/#organization`;
    const websiteId = `${siteUrl}/#website`;
    const softwareId = `${siteUrl}/#software`;
    const webpageId = `${canonicalUrl.value}#webpage`;

    const jsonLd: Record<string, unknown>[] = [
      {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        '@id': websiteId,
        name: siteName,
        url: siteUrl,
        inLanguage: currentLocale.iso,
        publisher: { '@id': organizationId },
      },
      {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        '@id': webpageId,
        name: title.value,
        description: description.value,
        url: canonicalUrl.value,
        inLanguage: currentLocale.iso,
        isPartOf: { '@id': websiteId },
        about: { '@id': softwareId },
        publisher: { '@id': organizationId },
        primaryImageOfPage: {
          '@type': 'ImageObject',
          '@id': `${resolvedImageUrl.value}#primaryimage`,
          url: resolvedImageUrl.value,
          width: resolvedImage.value.width,
          height: resolvedImage.value.height,
        },
      },
      {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        '@id': organizationId,
        name: siteName,
        url: siteUrl,
        logo: toSiteUrl('/logo-192.png'),
        sameAs: [`https://github.com/${config.public.githubRepo}`],
      },
    ];

    // Для главной и страницы скачивания добавим более "вкусную" разметку.
    if (isHome || isDownload) {
      jsonLd.push({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        '@id': softwareId,
        name: siteName,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Windows, macOS, Linux',
        description: description.value,
        url: canonicalUrl.value,
        mainEntityOfPage: { '@id': webpageId },
        author: { '@id': organizationId },
        publisher: { '@id': organizationId },
        image: resolvedImageUrl.value,
        screenshot: toSiteUrl('/screenshots/1.png'),
        softwareVersion: 'latest',
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD',
        },
        downloadUrl:
          config.public.githubReleasesUrl ||
          `https://github.com/${config.public.githubRepo}/releases`,
      });
    }

    // FAQ rich snippets - Google показывает их прямо в выдаче
    if (isHome) {
      const content = getContent(locale.value as LocaleCode);
      if (content.faq?.length) {
        jsonLd.push({
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          '@id': `${canonicalUrl.value}#faq`,
          inLanguage: currentLocale.iso,
          isPartOf: { '@id': webpageId },
          mainEntity: content.faq.map((item) => ({
            '@type': 'Question',
            name: item.question,
            acceptedAnswer: {
              '@type': 'Answer',
              // HTML-теги из ответа убираем для JSON-LD
              text: item.answer.replace(/<[^>]*>/g, ''),
            },
          })),
        });
      }
    }

    return {
      htmlAttrs: {
        lang: currentLocale.iso,
        dir: 'dir' in currentLocale ? currentLocale.dir : 'ltr',
      },
      link: links,
      meta: [
        { name: 'author', content: 'Agent Teams' },
        { name: 'application-name', content: siteName },
        { name: 'apple-mobile-web-app-title', content: siteName },
        { name: 'format-detection', content: 'telephone=no' },
        { name: 'theme-color', content: '#00f0ff' },
        {
          name: 'googlebot',
          content:
            options.robots ||
            'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1',
        },
        { property: 'og:locale', content: ogLocale },
        ...ogAlternateLocales.map((content) => ({ property: 'og:locale:alternate', content })),
        {
          name: 'keywords',
          content:
            'claude code, codex, opencode, cursor, supergrok, github copilot, z.ai, minimax, kiro, agent teams, AI agents, kanban board, code review, multi-agent orchestration, desktop app, free, open source',
        },
      ],
      script: jsonLd.map((item) => ({
        type: 'application/ld+json',
        children: JSON.stringify(item),
      })),
    };
  });
};
