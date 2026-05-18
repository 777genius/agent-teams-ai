import {
  transformerNotationDiff,
  transformerNotationErrorLevel,
  transformerNotationFocus,
  transformerNotationHighlight
} from "@shikijs/transformers";
import { fileURLToPath } from "node:url";
import { defineConfig, type DefaultTheme } from "vitepress";
import llmstxt, { copyOrDownloadAsMarkdownButtons } from "vitepress-plugin-llms";

const REPO = "777genius/agent-teams-ai";
const SITE_TITLE = "Agent Teams Docs";
const SITE_DESCRIPTION = "Documentation for Agent Teams, a local desktop app for AI agent orchestration.";

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");
const normalizeBase = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "/";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}/`;
};
const withTrailingSlash = (value: string) => `${trimTrailingSlash(value)}/`;

const appBase = normalizeBase(process.env.NUXT_APP_BASE_URL || "/");
const base = appBase === "/" ? "/docs/" : `${appBase}docs/`;
const siteUrl = trimTrailingSlash(
  process.env.NUXT_PUBLIC_SITE_URL || "https://777genius.github.io/agent-teams-ai"
);
const publicBaseUrl =
  appBase === "/" || siteUrl.endsWith(trimTrailingSlash(appBase))
    ? withTrailingSlash(siteUrl)
    : `${withTrailingSlash(siteUrl)}${appBase.replace(/^\/+/, "")}`;
const docsUrl = `${publicBaseUrl}docs/`;
const downloadUrl = `${publicBaseUrl}download/`;
const ruDownloadUrl = `${publicBaseUrl}ru/download/`;
const landingPublicDir = fileURLToPath(new URL("../../public", import.meta.url));

const rootGuide: DefaultTheme.SidebarItem[] = [
  {
    text: "Start",
    items: [
      { text: "Installation", link: "/guide/installation" },
      { text: "Quickstart", link: "/guide/quickstart" },
      { text: "Runtime setup", link: "/guide/runtime-setup" }
    ]
  },
  {
    text: "Guide",
    items: [
      { text: "Create a team", link: "/guide/create-team" },
      { text: "Agent workflow", link: "/guide/agent-workflow" },
      { text: "Code review", link: "/guide/code-review" },
      { text: "MCP integration", link: "/guide/mcp-integration" },
      { text: "Team brief examples", link: "/guide/team-brief-examples" }
    ]
  },
  {
    text: "Operations",
    items: [
      { text: "Git and worktree strategy", link: "/guide/git-worktree-strategy" },
      { text: "Troubleshooting", link: "/guide/troubleshooting" }
    ]
  },
  {
    text: "Developers",
    items: [{ text: "Developer hub", link: "/developers/" }]
  },
  {
    text: "Reference",
    items: [
      { text: "Concepts", link: "/reference/concepts" },
      { text: "Providers and runtimes", link: "/reference/providers-runtimes" },
      { text: "Contributor architecture", link: "/reference/contributor-architecture" },
      { text: "Release notes", link: "/reference/release-notes" },
      { text: "Privacy and local data", link: "/reference/privacy-local-data" },
      { text: "FAQ", link: "/reference/faq" }
    ]
  }
];

const ruGuide: DefaultTheme.SidebarItem[] = [
  {
    text: "Старт",
    items: [
      { text: "Установка", link: "/ru/guide/installation" },
      { text: "Быстрый старт", link: "/ru/guide/quickstart" },
      { text: "Настройка рантайма", link: "/ru/guide/runtime-setup" }
    ]
  },
  {
    text: "Руководство",
    items: [
      { text: "Создание команды", link: "/ru/guide/create-team" },
      { text: "Работа агентов", link: "/ru/guide/agent-workflow" },
      { text: "Код-ревью", link: "/ru/guide/code-review" },
      { text: "Интеграция MCP", link: "/ru/guide/mcp-integration" },
      { text: "Примеры брифов", link: "/ru/guide/team-brief-examples" }
    ]
  },
  {
    text: "Операции",
    items: [
      { text: "Стратегия Git и worktree", link: "/ru/guide/git-worktree-strategy" },
      { text: "Диагностика", link: "/ru/guide/troubleshooting" }
    ]
  },
  {
    text: "Разработчикам",
    items: [{ text: "Хаб разработчика", link: "/ru/developers/" }]
  },
  {
    text: "Справочник",
    items: [
      { text: "Концепции", link: "/ru/reference/concepts" },
      { text: "Провайдеры и рантаймы", link: "/ru/reference/providers-runtimes" },
      { text: "Архитектура для контрибьюторов", link: "/ru/reference/contributor-architecture" },
      { text: "Релизы", link: "/ru/reference/release-notes" },
      { text: "Приватность и локальные данные", link: "/ru/reference/privacy-local-data" },
      { text: "FAQ", link: "/ru/reference/faq" }
    ]
  }
];

const rootNav: DefaultTheme.NavItem[] = [
  { text: "Guide", link: "/guide/quickstart", activeMatch: "^/guide/(?!troubleshooting(?:/|$))" },
  { text: "Developers", link: "/developers/", activeMatch: "^/developers/" },
  { text: "Reference", link: "/reference/concepts", activeMatch: "^/reference/" },
  {
    text: "Troubleshooting",
    link: "/guide/troubleshooting",
    activeMatch: "^/guide/troubleshooting(?:/|$)"
  },
  { text: "Download", link: downloadUrl, target: "_self", noIcon: true }
];

const ruNav: DefaultTheme.NavItem[] = [
  {
    text: "Руководство",
    link: "/ru/guide/quickstart",
    activeMatch: "^/ru/guide/(?!troubleshooting(?:/|$))"
  },
  { text: "Разработчикам", link: "/ru/developers/", activeMatch: "^/ru/developers/" },
  { text: "Справочник", link: "/ru/reference/concepts", activeMatch: "^/ru/reference/" },
  {
    text: "Диагностика",
    link: "/ru/guide/troubleshooting",
    activeMatch: "^/ru/guide/troubleshooting(?:/|$)"
  },
  { text: "Скачать", link: ruDownloadUrl, target: "_self", noIcon: true }
];

export default defineConfig({
  lang: "en-US",
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  base,
  cleanUrls: true,
  ignoreDeadLinks: [/\/download/],
  lastUpdated: true,
  sitemap: {
    hostname: docsUrl,
    lastmodDateOnly: true
  },
  head: [
    ["link", { rel: "icon", type: "image/png", href: `${base}logo-192.png` }],
    ["link", { rel: "canonical", href: docsUrl }],
    ["meta", { name: "robots", content: "index, follow" }],
    ["meta", { name: "author", content: "777genius" }],
    ["meta", { name: "generator", content: "VitePress" }],
    ["meta", { name: "color-scheme", content: "light dark" }],
    ["meta", { name: "theme-color", content: "#f8fafc", media: "(prefers-color-scheme: light)" }],
    ["meta", { name: "theme-color", content: "#0a0a0f", media: "(prefers-color-scheme: dark)" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: SITE_TITLE }],
    ["meta", { property: "og:description", content: SITE_DESCRIPTION }],
    ["meta", { property: "og:url", content: docsUrl }],
    ["meta", { property: "og:image", content: `${publicBaseUrl}og-image.png` }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { property: "og:site_name", content: "Agent Teams" }],
    ["meta", { property: "og:locale", content: "en_US" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: SITE_TITLE }],
    ["meta", { name: "twitter:description", content: SITE_DESCRIPTION }],
    ["meta", { name: "twitter:image", content: `${publicBaseUrl}og-image.png` }],
    [
      "script",
      { type: "application/ld+json" },
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: "Agent Teams",
        description: SITE_DESCRIPTION,
        url: publicBaseUrl,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "macOS, Windows, Linux",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" }
      })
    ]
  ],
  vite: {
    publicDir: landingPublicDir,
    plugins: [llmstxt()],
    optimizeDeps: {
      include: ["medium-zoom", "vitepress-codeblock-collapse"]
    }
  },
  markdown: {
    codeTransformers: [
      transformerNotationDiff(),
      transformerNotationFocus(),
      transformerNotationHighlight(),
      transformerNotationErrorLevel()
    ],
    config(md) {
      md.use(copyOrDownloadAsMarkdownButtons);
    }
  },
  themeConfig: {
    logo: {
      light: "/logo-192.png",
      dark: "/logo-192.png",
      alt: "Agent Teams"
    },
    siteTitle: "Agent Teams",
    outline: {
      level: [2, 3],
      label: "On this page"
    },
    externalLinkIcon: true,
    darkModeSwitchLabel: "Appearance",
    lightModeSwitchTitle: "Switch to light theme",
    darkModeSwitchTitle: "Switch to dark theme",
    search: {
      provider: "local",
      options: {
        translations: {
          button: {
            buttonText: "Search...",
            buttonAriaLabel: "Search documentation"
          },
          modal: {
            noResultsText: "No results found",
            footer: {
              selectText: "to select",
              navigateText: "to navigate",
              closeText: "to close"
            }
          }
        }
      }
    },
    lastUpdated: {
      text: "Last updated",
      formatOptions: {
        dateStyle: "medium",
        timeStyle: "short",
        forceLocale: true
      }
    },
    nav: rootNav,
    sidebar: {
      "/ru/": ruGuide,
      "/": rootGuide
    },
    socialLinks: [{ icon: "github", link: `https://github.com/${REPO}` }],
    editLink: {
      pattern: `https://github.com/${REPO}/edit/main/landing/product-docs/:path`,
      text: "Edit this page on GitHub"
    },
    footer: {
      message: "Free and open source.",
      copyright: "Copyright © 777genius"
    }
  },
  locales: {
    root: {
      label: "English",
      lang: "en-US",
      themeConfig: {
        nav: rootNav,
        docFooter: {
          prev: "Previous",
          next: "Next"
        }
      }
    },
    ru: {
      label: "Русский",
      lang: "ru-RU",
      title: "Документация Agent Teams",
      description: "Документация Agent Teams, локального desktop-приложения для оркестрации AI-агентов.",
      themeConfig: {
        nav: ruNav,
        outline: {
          level: [2, 3],
          label: "На этой странице"
        },
        darkModeSwitchLabel: "Оформление",
        lightModeSwitchTitle: "Переключить на светлую тему",
        darkModeSwitchTitle: "Переключить на тёмную тему",
        search: {
          provider: "local",
          options: {
            translations: {
              button: {
                buttonText: "Поиск по документации",
                buttonAriaLabel: "поиск по документации"
              },
              modal: {
                noResultsText: "Результаты не найдены",
                footer: {
                  selectText: "для выбора",
                  navigateText: "для навигации",
                  closeText: "для закрытия"
                }
              }
            }
          }
        },
        lastUpdated: {
          text: "Обновлено",
          formatOptions: {
            dateStyle: "medium",
            timeStyle: "short",
            forceLocale: true
          }
        },
        editLink: {
          pattern: `https://github.com/${REPO}/edit/main/landing/product-docs/:path`,
          text: "Редактировать на GitHub"
        },
        docFooter: {
          prev: "Назад",
          next: "Дальше"
        },
        footer: {
          message: "Бесплатно и с открытым кодом.",
          copyright: "Copyright © 777genius"
        }
      }
    }
  }
});
