import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vuetify from "vite-plugin-vuetify";
import { generateI18nRoutes, supportedLocales } from "./data/i18n";

declare const process: {
  env: Record<string, string | undefined>;
};

const siteUrl = process.env.NUXT_PUBLIC_SITE_URL || "https://777genius.github.io/agent-teams-ai";
const githubRepo = process.env.NUXT_PUBLIC_GITHUB_REPO || "777genius/agent-teams-ai";
const githubReleasesUrl = `https://github.com/${githubRepo}/releases`;
const muxPlaybackId = process.env.NUXT_PUBLIC_MUX_PLAYBACK_ID || "qyeNuDjFqoDALK8eB02jMTOWUz006BdIhiqiAip3U00x7I";
const muxBackgroundPlaybackId = process.env.NUXT_PUBLIC_MUX_BACKGROUND_PLAYBACK_ID || muxPlaybackId;
const baseURL = process.env.NUXT_APP_BASE_URL || "/";
const basePrefixedDocsPath = `${baseURL.replace(/\/?$/, "/")}docs`;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSeoTitle = "Agent Teams - AI Agent Orchestration for Developers";
const defaultSeoDescription = "Free, open-source desktop app for AI agent teams. Start with a free model with no auth, then connect Claude, Codex, or OpenCode when you need more models.";
const defaultSeoImage = `${siteUrl.replace(/\/+$/, "")}/og-image-agent-teams-v5.png`;

export default defineNuxtConfig({
  compatibilityDate: "2026-01-19",
  devtools: { enabled: false },
  ssr: true,
  app: {
    baseURL,
    head: {
      title: defaultSeoTitle,
      meta: [
        { name: "description", content: defaultSeoDescription },
        { name: "robots", content: "noindex, nofollow" },
        { property: "og:title", content: defaultSeoTitle },
        { property: "og:description", content: defaultSeoDescription },
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: "Agent Teams" },
        { property: "og:image", content: defaultSeoImage },
        { property: "og:image:type", content: "image/png" },
        { property: "og:image:width", content: "1200" },
        { property: "og:image:height", content: "630" },
        { property: "og:image:alt", content: "Agent Teams - AI agent orchestration" },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: defaultSeoTitle },
        { name: "twitter:description", content: defaultSeoDescription },
        { name: "twitter:image", content: defaultSeoImage },
        { name: "twitter:image:alt", content: "Agent Teams - AI agent orchestration" }
      ],
      link: [
        { rel: "icon", type: "image/x-icon", href: `${baseURL}favicon.ico` },
        { rel: "icon", type: "image/png", sizes: "32x32", href: `${baseURL}favicon-32.png` },
        { rel: "apple-touch-icon", sizes: "192x192", href: `${baseURL}logo-192.png` },
        { rel: "alternate", type: "text/plain", title: "llms.txt", href: `${baseURL}llms.txt` },
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
      isCustomElement: (tag: string) => tag.startsWith("swiper-") || tag === "mux-video"
    }
  },
  vite: {
    plugins: [vuetify({ autoImport: true })]
  },
  nitro: {
    compressPublicAssets: true,
    publicAssets: [
      {
        baseURL: "/screenshots",
        dir: resolve(repoRoot, "docs/screenshots"),
        maxAge: 60 * 60 * 24 * 365
      }
    ],
    prerender: {
      ignore: [
        "/docs",
        "/docs/**",
        basePrefixedDocsPath,
        `${basePrefixedDocsPath}/**`
      ],
      routes: [
        ...generateI18nRoutes(),
        "/sitemap.xml",
        "/robots.txt",
        "/llms.txt"
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
    locales: [...supportedLocales],
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
    name: "Agent Teams"
  },
  runtimeConfig: {
    github: {
      token: process.env.GITHUB_TOKEN
    },
    public: {
      siteUrl,
      githubRepo,
      githubReleasesUrl,
      muxPlaybackId,
      muxBackgroundPlaybackId
    }
  }
});
