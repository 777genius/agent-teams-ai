import type { DefaultTheme } from "vitepress";

export const rootGuide: DefaultTheme.SidebarItem[] = [
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
      { text: "Notification channels", link: "/guide/notification-channels" },
      { text: "Review and approve", link: "/guide/review-and-approve" },
      { text: "Team configuration", link: "/guide/create-team" },
      { text: "Agent workflow", link: "/guide/agent-workflow" },
      { text: "Code review", link: "/guide/code-review" },
      { text: "MCP integration", link: "/guide/mcp-integration" },
      { text: "Connect an external AI agent", link: "/guide/connect-external-agent" },
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

export const ruGuide: DefaultTheme.SidebarItem[] = [
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
      { text: "Каналы уведомлений", link: "/ru/guide/notification-channels" },
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
