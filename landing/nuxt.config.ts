import vuetify from "vite-plugin-vuetify";
import { generateI18nRoutes, supportedLocales } from "./data/i18n";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: any;

const siteUrl = process.env.NUXT_PUBLIC_SITE_URL || "https://claude-agent-teams.dev";
const githubRepo = process.env.NUXT_PUBLIC_GITHUB_REPO || "777genius/claude_agent_teams_ui";
const githubReleasesUrl = `https://github.com/${githubRepo}/releases`;
const baseURL = process.env.NUXT_APP_BASE_URL || "/";

export default defineNuxtConfig({
  compatibilityDate: "2026-01-19",
  ssr: true,
  app: {
    baseURL,
    head: {
      link: [
        { rel: "icon", type: "image/x-icon", href: `${baseURL}favicon.ico` },
        { rel: "icon", type: "image/png", sizes: "32x32", href: `${baseURL}favicon-32.png` },
        { rel: "apple-touch-icon", sizes: "192x192", href: `${baseURL}logo-192.png` },
        { rel: "dns-prefetch", href: "https://api.github.com" },
        { rel: "preconnect", href: "https://fonts.googleapis.com" },
        { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
        { rel: "preload", href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap", as: "style" },
        { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" }
      ]
    }
  },
  modules: [
    "@pinia/nuxt",
    "@nuxtjs/i18n",
    "@vueuse/nuxt",
    "nuxt-icon",
    "@nuxt/eslint"
  ],
  css: ["~/assets/styles/main.scss"],
  components: [
    {
      path: "~/components",
      pathPrefix: false
    }
  ],
  build: {
    transpile: ["vuetify"]
  },
  vue: {
    compilerOptions: {
      isCustomElement: (tag: string) => tag.startsWith("swiper-")
    }
  },
  vite: {
    plugins: [vuetify({ autoImport: true })]
  },
  nitro: {
    compressPublicAssets: true,
    prerender: {
      routes: [
        ...generateI18nRoutes(),
        "/sitemap.xml",
        "/robots.txt"
      ]
    }
  },
  routeRules: {
    "/_nuxt/**": {
      headers: { "Cache-Control": "public, max-age=31536000, immutable" }
    }
  },
  i18n: {
    restructureDir: false,
    locales: [...supportedLocales] as any,
    defaultLocale: "en",
    strategy: "prefix_except_default",
    lazy: true,
    langDir: "locales",
    bundle: {
      optimizeTranslationDirective: false
    },
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: "i18n_redirected",
      redirectOn: "root",
      alwaysRedirect: false,
      fallbackLocale: "en"
    }
  },
  // @ts-expect-error - field provided by nuxt modules
  site: {
    url: siteUrl,
    name: "Claude Agent Teams"
  },
  runtimeConfig: {
    github: {
      token: process.env.GITHUB_TOKEN
    },
    public: {
      siteUrl,
      githubRepo,
      githubReleasesUrl
    }
  }
});
