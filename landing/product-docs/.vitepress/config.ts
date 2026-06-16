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
const embeddedDocsBase = appBase === "/" ? "/docs/" : `${appBase}docs/`;
const base = process.env.VITEPRESS_BASE ? normalizeBase(process.env.VITEPRESS_BASE) : embeddedDocsBase;
const landingSiteUrl = trimTrailingSlash(
  process.env.AGENT_TEAMS_LANDING_SITE_URL ||
    process.env.NUXT_PUBLIC_LANDING_SITE_URL ||
    process.env.VITEPRESS_LANDING_SITE_URL ||
    process.env.NUXT_PUBLIC_SITE_URL ||
    "https://777genius.github.io/agent-teams-ai"
);
const configuredDocsSiteUrl = process.env.AGENT_TEAMS_DOCS_SITE_URL || process.env.VITEPRESS_SITE_URL;
const publicBaseUrl =
  appBase === "/" || landingSiteUrl.endsWith(trimTrailingSlash(appBase))
    ? withTrailingSlash(landingSiteUrl)
    : `${withTrailingSlash(landingSiteUrl)}${appBase.replace(/^\/+/, "")}`;
const docsUrl = configuredDocsSiteUrl ? withTrailingSlash(configuredDocsSiteUrl) : `${publicBaseUrl}docs/`;
const downloadUrl = `${publicBaseUrl}download/`;
const ruDownloadUrl = `${publicBaseUrl}ru/download/`;
const ogImageUrl = `${publicBaseUrl}og-image-agent-teams-v6.png`;
const landingPublicDir = fileURLToPath(new URL("../../public", import.meta.url));

const rootGuide: DefaultTheme.SidebarItem[] = [
  {
    text: "Start",
    items: [
      { text: "Installation", link: "/guide/installation" },
      { text: "Beginner workflow", link: "/guide/beginner-workflow" },
      { text: "Quickstart", link: "/guide/quickstart" },
      { text: "Runtime setup", link: "/guide/runtime-setup" }
    ]
  },
  {
    text: "Guide",
    items: [
      { text: "Create your first team", link: "/guide/create-first-team" },
      { text: "Run and monitor work", link: "/guide/run-and-monitor-work" },
      { text: "Review and approve", link: "/guide/review-and-approve" },
      { text: "Team configuration", link: "/guide/create-team" },
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
      { text: "Путь новичка", link: "/ru/guide/beginner-workflow" },
      { text: "Быстрый старт", link: "/ru/guide/quickstart" },
      { text: "Настройка рантайма", link: "/ru/guide/runtime-setup" }
    ]
  },
  {
    text: "Руководство",
    items: [
      { text: "Создать первую команду", link: "/ru/guide/create-first-team" },
      { text: "Запуск и мониторинг", link: "/ru/guide/run-and-monitor-work" },
      { text: "Проверка и approval", link: "/ru/guide/review-and-approve" },
      { text: "Настройка команды", link: "/ru/guide/create-team" },
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
  {
    text: "Guide",
    link: "/guide/beginner-workflow",
    activeMatch: "^/guide/(?!troubleshooting(?:/|$))"
  },
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
    link: "/ru/guide/beginner-workflow",
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

// Additional locales (zh, es, ja, fr, de) are generated from a single strings table
// so every locale stays structurally identical to the English/Russian sidebars and navs.
interface DocsLocaleStrings {
  siteTitle: string;
  siteDescription: string;
  nav: { guide: string; developers: string; reference: string; troubleshooting: string; download: string };
  sidebarGroups: { start: string; guide: string; operations: string; developers: string; reference: string };
  sidebarItems: {
    installation: string;
    quickstart: string;
    runtimeSetup: string;
    createTeam: string;
    agentWorkflow: string;
    codeReview: string;
    mcpIntegration: string;
    teamBriefExamples: string;
    gitWorktreeStrategy: string;
    troubleshooting: string;
    developerHub: string;
    concepts: string;
    providersRuntimes: string;
    contributorArchitecture: string;
    releaseNotes: string;
    privacyLocalData: string;
    faq: string;
  };
  ui: {
    searchButton: string;
    searchAria: string;
    noResults: string;
    selectText: string;
    navigateText: string;
    closeText: string;
    footerMessage: string;
    docFooterPrev: string;
    docFooterNext: string;
    outlineLabel: string;
    darkModeSwitchLabel: string;
    lightModeSwitchTitle: string;
    darkModeSwitchTitle: string;
    lastUpdatedText: string;
    editLinkText: string;
  };
}

interface DocsLocaleDefinition {
  loc: string;
  lang: string;
  label: string;
  strings: DocsLocaleStrings;
}

const additionalLocales: DocsLocaleDefinition[] = [
  {
    loc: "zh",
    lang: "zh-Hans",
    label: "简体中文",
    strings: {
      siteTitle: "Agent Teams 文档",
      siteDescription: "Agent Teams 文档，这是一款用于编排 AI 智能体的本地桌面应用。",
      nav: { guide: "指南", developers: "开发者", reference: "参考", troubleshooting: "故障排查", download: "下载" },
      sidebarGroups: { start: "开始", guide: "指南", operations: "运维", developers: "开发者", reference: "参考" },
      sidebarItems: {
        installation: "安装",
        quickstart: "快速开始",
        runtimeSetup: "运行时设置",
        createTeam: "创建团队",
        agentWorkflow: "智能体工作流",
        codeReview: "代码审查",
        mcpIntegration: "MCP 集成",
        teamBriefExamples: "团队简报示例",
        gitWorktreeStrategy: "Git 与 worktree 策略",
        troubleshooting: "故障排查",
        developerHub: "开发者中心",
        concepts: "概念",
        providersRuntimes: "提供方与运行时",
        contributorArchitecture: "贡献者架构",
        releaseNotes: "发布说明",
        privacyLocalData: "隐私与本地数据",
        faq: "常见问题"
      },
      ui: {
        searchButton: "搜索……",
        searchAria: "搜索文档",
        noResults: "未找到结果",
        selectText: "选择",
        navigateText: "导航",
        closeText: "关闭",
        footerMessage: "免费且开源。",
        docFooterPrev: "上一页",
        docFooterNext: "下一页",
        outlineLabel: "本页内容",
        darkModeSwitchLabel: "外观",
        lightModeSwitchTitle: "切换到浅色主题",
        darkModeSwitchTitle: "切换到深色主题",
        lastUpdatedText: "最后更新",
        editLinkText: "在 GitHub 上编辑此页"
      }
    }
  },
  {
    loc: "es",
    lang: "es-ES",
    label: "Español",
    strings: {
      siteTitle: "Documentación de Agent Teams",
      siteDescription:
        "Documentación de Agent Teams, una aplicación de escritorio local para la orquestación de agentes de IA.",
      nav: {
        guide: "Guía",
        developers: "Desarrolladores",
        reference: "Referencia",
        troubleshooting: "Solución de problemas",
        download: "Descargar"
      },
      sidebarGroups: {
        start: "Inicio",
        guide: "Guía",
        operations: "Operaciones",
        developers: "Desarrolladores",
        reference: "Referencia"
      },
      sidebarItems: {
        installation: "Instalación",
        quickstart: "Inicio rápido",
        runtimeSetup: "Configuración del runtime",
        createTeam: "Crear un equipo",
        agentWorkflow: "Flujo de trabajo de los agentes",
        codeReview: "Revisión de código",
        mcpIntegration: "Integración de MCP",
        teamBriefExamples: "Ejemplos de briefing de equipo",
        gitWorktreeStrategy: "Estrategia de Git y worktree",
        troubleshooting: "Solución de problemas",
        developerHub: "Centro para desarrolladores",
        concepts: "Conceptos",
        providersRuntimes: "Proveedores y runtimes",
        contributorArchitecture: "Arquitectura para colaboradores",
        releaseNotes: "Notas de la versión",
        privacyLocalData: "Privacidad y datos locales",
        faq: "Preguntas frecuentes"
      },
      ui: {
        searchButton: "Buscar...",
        searchAria: "Buscar en la documentación",
        noResults: "No se encontraron resultados",
        selectText: "para seleccionar",
        navigateText: "para navegar",
        closeText: "para cerrar",
        footerMessage: "Gratis y de código abierto.",
        docFooterPrev: "Anterior",
        docFooterNext: "Siguiente",
        outlineLabel: "En esta página",
        darkModeSwitchLabel: "Apariencia",
        lightModeSwitchTitle: "Cambiar al tema claro",
        darkModeSwitchTitle: "Cambiar al tema oscuro",
        lastUpdatedText: "Última actualización",
        editLinkText: "Editar esta página en GitHub"
      }
    }
  },
  {
    loc: "ja",
    lang: "ja-JP",
    label: "日本語",
    strings: {
      siteTitle: "Agent Teams ドキュメント",
      siteDescription:
        "AI エージェントのオーケストレーションを行うローカル デスクトップアプリ Agent Teams のドキュメントです。",
      nav: {
        guide: "ガイド",
        developers: "開発者向け",
        reference: "リファレンス",
        troubleshooting: "トラブルシューティング",
        download: "ダウンロード"
      },
      sidebarGroups: {
        start: "はじめに",
        guide: "ガイド",
        operations: "運用",
        developers: "開発者向け",
        reference: "リファレンス"
      },
      sidebarItems: {
        installation: "インストール",
        quickstart: "クイックスタート",
        runtimeSetup: "ランタイムの設定",
        createTeam: "チームの作成",
        agentWorkflow: "エージェントのワークフロー",
        codeReview: "コードレビュー",
        mcpIntegration: "MCP 連携",
        teamBriefExamples: "チームブリーフの例",
        gitWorktreeStrategy: "Git と worktree の戦略",
        troubleshooting: "トラブルシューティング",
        developerHub: "開発者ハブ",
        concepts: "コンセプト",
        providersRuntimes: "プロバイダーとランタイム",
        contributorArchitecture: "コントリビューター向けアーキテクチャ",
        releaseNotes: "リリースノート",
        privacyLocalData: "プライバシーとローカルデータ",
        faq: "FAQ"
      },
      ui: {
        searchButton: "検索...",
        searchAria: "ドキュメントを検索",
        noResults: "結果が見つかりませんでした",
        selectText: "選択",
        navigateText: "移動",
        closeText: "閉じる",
        footerMessage: "無料でオープンソースです。",
        docFooterPrev: "前へ",
        docFooterNext: "次へ",
        outlineLabel: "このページの内容",
        darkModeSwitchLabel: "外観",
        lightModeSwitchTitle: "ライトテーマに切り替える",
        darkModeSwitchTitle: "ダークテーマに切り替える",
        lastUpdatedText: "最終更新",
        editLinkText: "GitHub でこのページを編集"
      }
    }
  },
  {
    loc: "fr",
    lang: "fr-FR",
    label: "Français",
    strings: {
      siteTitle: "Documentation Agent Teams",
      siteDescription:
        "Documentation d'Agent Teams, une application de bureau locale pour l'orchestration d'agents IA.",
      nav: {
        guide: "Guide",
        developers: "Développeurs",
        reference: "Référence",
        troubleshooting: "Dépannage",
        download: "Télécharger"
      },
      sidebarGroups: {
        start: "Démarrer",
        guide: "Guide",
        operations: "Opérations",
        developers: "Développeurs",
        reference: "Référence"
      },
      sidebarItems: {
        installation: "Installation",
        quickstart: "Démarrage rapide",
        runtimeSetup: "Configuration du runtime",
        createTeam: "Créer une équipe",
        agentWorkflow: "Flux de travail des agents",
        codeReview: "Revue de code",
        mcpIntegration: "Intégration MCP",
        teamBriefExamples: "Exemples de briefs d'équipe",
        gitWorktreeStrategy: "Stratégie Git et worktree",
        troubleshooting: "Dépannage",
        developerHub: "Hub développeur",
        concepts: "Concepts",
        providersRuntimes: "Fournisseurs et runtimes",
        contributorArchitecture: "Architecture pour les contributeurs",
        releaseNotes: "Notes de version",
        privacyLocalData: "Confidentialité et données locales",
        faq: "FAQ"
      },
      ui: {
        searchButton: "Rechercher...",
        searchAria: "Rechercher dans la documentation",
        noResults: "Aucun résultat trouvé",
        selectText: "pour sélectionner",
        navigateText: "pour naviguer",
        closeText: "pour fermer",
        footerMessage: "Gratuit et open source.",
        docFooterPrev: "Précédent",
        docFooterNext: "Suivant",
        outlineLabel: "Sur cette page",
        darkModeSwitchLabel: "Apparence",
        lightModeSwitchTitle: "Passer au thème clair",
        darkModeSwitchTitle: "Passer au thème sombre",
        lastUpdatedText: "Dernière mise à jour",
        editLinkText: "Modifier cette page sur GitHub"
      }
    }
  },
  {
    loc: "de",
    lang: "de-DE",
    label: "Deutsch",
    strings: {
      siteTitle: "Agent Teams Dokumentation",
      siteDescription:
        "Dokumentation für Agent Teams, eine lokale Desktop-App zur Orchestrierung von KI-Agenten.",
      nav: {
        guide: "Anleitung",
        developers: "Entwickler",
        reference: "Referenz",
        troubleshooting: "Fehlerbehebung",
        download: "Download"
      },
      sidebarGroups: {
        start: "Start",
        guide: "Anleitung",
        operations: "Betrieb",
        developers: "Entwickler",
        reference: "Referenz"
      },
      sidebarItems: {
        installation: "Installation",
        quickstart: "Schnellstart",
        runtimeSetup: "Runtime-Einrichtung",
        createTeam: "Team erstellen",
        agentWorkflow: "Agent-Workflow",
        codeReview: "Code-Review",
        mcpIntegration: "MCP-Integration",
        teamBriefExamples: "Team-Briefing-Beispiele",
        gitWorktreeStrategy: "Git- und Worktree-Strategie",
        troubleshooting: "Fehlerbehebung",
        developerHub: "Entwickler-Hub",
        concepts: "Konzepte",
        providersRuntimes: "Anbieter und Runtimes",
        contributorArchitecture: "Architektur für Mitwirkende",
        releaseNotes: "Versionshinweise",
        privacyLocalData: "Datenschutz und lokale Daten",
        faq: "FAQ"
      },
      ui: {
        searchButton: "Suchen...",
        searchAria: "Dokumentation durchsuchen",
        noResults: "Keine Ergebnisse gefunden",
        selectText: "zum Auswählen",
        navigateText: "zum Navigieren",
        closeText: "zum Schließen",
        footerMessage: "Kostenlos und quelloffen.",
        docFooterPrev: "Zurück",
        docFooterNext: "Weiter",
        outlineLabel: "Auf dieser Seite",
        darkModeSwitchLabel: "Darstellung",
        lightModeSwitchTitle: "Zum hellen Design wechseln",
        darkModeSwitchTitle: "Zum dunklen Design wechseln",
        lastUpdatedText: "Zuletzt aktualisiert",
        editLinkText: "Diese Seite auf GitHub bearbeiten"
      }
    }
  }
];

const buildLocaleGuide = (loc: string, s: DocsLocaleStrings): DefaultTheme.SidebarItem[] => [
  {
    text: s.sidebarGroups.start,
    items: [
      { text: s.sidebarItems.installation, link: `/${loc}/guide/installation` },
      { text: s.sidebarItems.quickstart, link: `/${loc}/guide/quickstart` },
      { text: s.sidebarItems.runtimeSetup, link: `/${loc}/guide/runtime-setup` }
    ]
  },
  {
    text: s.sidebarGroups.guide,
    items: [
      { text: s.sidebarItems.createTeam, link: `/${loc}/guide/create-team` },
      { text: s.sidebarItems.agentWorkflow, link: `/${loc}/guide/agent-workflow` },
      { text: s.sidebarItems.codeReview, link: `/${loc}/guide/code-review` },
      { text: s.sidebarItems.mcpIntegration, link: `/${loc}/guide/mcp-integration` },
      { text: s.sidebarItems.teamBriefExamples, link: `/${loc}/guide/team-brief-examples` }
    ]
  },
  {
    text: s.sidebarGroups.operations,
    items: [
      { text: s.sidebarItems.gitWorktreeStrategy, link: `/${loc}/guide/git-worktree-strategy` },
      { text: s.sidebarItems.troubleshooting, link: `/${loc}/guide/troubleshooting` }
    ]
  },
  {
    text: s.sidebarGroups.developers,
    items: [{ text: s.sidebarItems.developerHub, link: `/${loc}/developers/` }]
  },
  {
    text: s.sidebarGroups.reference,
    items: [
      { text: s.sidebarItems.concepts, link: `/${loc}/reference/concepts` },
      { text: s.sidebarItems.providersRuntimes, link: `/${loc}/reference/providers-runtimes` },
      { text: s.sidebarItems.contributorArchitecture, link: `/${loc}/reference/contributor-architecture` },
      { text: s.sidebarItems.releaseNotes, link: `/${loc}/reference/release-notes` },
      { text: s.sidebarItems.privacyLocalData, link: `/${loc}/reference/privacy-local-data` },
      { text: s.sidebarItems.faq, link: `/${loc}/reference/faq` }
    ]
  }
];

const buildLocaleNav = (loc: string, s: DocsLocaleStrings): DefaultTheme.NavItem[] => [
  {
    text: s.nav.guide,
    link: `/${loc}/guide/quickstart`,
    activeMatch: `^/${loc}/guide/(?!troubleshooting(?:/|$))`
  },
  { text: s.nav.developers, link: `/${loc}/developers/`, activeMatch: `^/${loc}/developers/` },
  { text: s.nav.reference, link: `/${loc}/reference/concepts`, activeMatch: `^/${loc}/reference/` },
  {
    text: s.nav.troubleshooting,
    link: `/${loc}/guide/troubleshooting`,
    activeMatch: `^/${loc}/guide/troubleshooting(?:/|$)`
  },
  { text: s.nav.download, link: `${publicBaseUrl}${loc}/download/`, target: "_self", noIcon: true }
];

const buildLocaleConfig = ({ loc, lang, label, strings: s }: DocsLocaleDefinition) => ({
  label,
  lang,
  title: s.siteTitle,
  description: s.siteDescription,
  themeConfig: {
    nav: buildLocaleNav(loc, s),
    outline: {
      level: [2, 3] as [number, number],
      label: s.ui.outlineLabel
    },
    darkModeSwitchLabel: s.ui.darkModeSwitchLabel,
    lightModeSwitchTitle: s.ui.lightModeSwitchTitle,
    darkModeSwitchTitle: s.ui.darkModeSwitchTitle,
    search: {
      provider: "local" as const,
      options: {
        translations: {
          button: {
            buttonText: s.ui.searchButton,
            buttonAriaLabel: s.ui.searchAria
          },
          modal: {
            noResultsText: s.ui.noResults,
            footer: {
              selectText: s.ui.selectText,
              navigateText: s.ui.navigateText,
              closeText: s.ui.closeText
            }
          }
        }
      }
    },
    lastUpdated: {
      text: s.ui.lastUpdatedText,
      formatOptions: {
        dateStyle: "medium" as const,
        timeStyle: "short" as const,
        forceLocale: true
      }
    },
    editLink: {
      pattern: `https://github.com/${REPO}/edit/main/landing/product-docs/:path`,
      text: s.ui.editLinkText
    },
    docFooter: {
      prev: s.ui.docFooterPrev,
      next: s.ui.docFooterNext
    },
    footer: {
      message: s.ui.footerMessage,
      copyright: "Copyright © 777genius"
    }
  }
});

const additionalLocaleSidebars = Object.fromEntries(
  additionalLocales.map((def) => [`/${def.loc}/`, buildLocaleGuide(def.loc, def.strings)])
);

const additionalLocaleConfigs = Object.fromEntries(
  additionalLocales.map((def) => [def.loc, buildLocaleConfig(def)])
);

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
    ["meta", { property: "og:image", content: ogImageUrl }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { property: "og:site_name", content: "Agent Teams" }],
    ["meta", { property: "og:locale", content: "en_US" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: SITE_TITLE }],
    ["meta", { name: "twitter:description", content: SITE_DESCRIPTION }],
    ["meta", { name: "twitter:image", content: ogImageUrl }],
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
      ...additionalLocaleSidebars,
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
    },
    ...additionalLocaleConfigs
  }
});
