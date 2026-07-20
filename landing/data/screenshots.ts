export type Screenshot = {
  path: string;
  previewPath: string;
  alt: string;
  ruAlt?: string;
  width: number;
  height: number;
};

/**
 * Screenshot definitions for the carousel.
 * Full-size images and their previews are served from the repository-level
 * docs/screenshots directory.
 */
export const screenshots: Screenshot[] = [
  {
    path: 'screenshots/13.jpg',
    previewPath: 'screenshots/previews/13.webp',
    alt: 'Connected AI coding providers and subscription limits',
    ruAlt: 'Подключённые AI-провайдеры и лимиты подписок',
    width: 2560,
    height: 1606,
  },
  {
    path: 'screenshots/14.png',
    previewPath: 'screenshots/previews/14.webp',
    alt: 'Token usage, costs, runs, and budget analytics',
    ruAlt: 'Аналитика токенов, расходов, запусков и бюджетов',
    width: 1854,
    height: 1156,
  },
  {
    path: 'screenshots/1.jpg',
    previewPath: 'screenshots/previews/1.webp',
    alt: 'Kanban board with agent tasks',
    ruAlt: 'Канбан-доска с задачами агентов',
    width: 2624,
    height: 1648,
  },
  {
    path: 'screenshots/2.jpg',
    previewPath: 'screenshots/previews/2.webp',
    alt: 'Live teammate status and resource usage',
    ruAlt: 'Статусы участников команды и использование ресурсов',
    width: 2560,
    height: 1602,
  },
  {
    path: 'screenshots/3.png',
    previewPath: 'screenshots/previews/3.webp',
    alt: 'Task discussion and review comments',
    ruAlt: 'Обсуждение задачи и комментарии ревью',
    width: 2622,
    height: 1646,
  },
  {
    path: 'screenshots/4.png',
    previewPath: 'screenshots/previews/4.webp',
    alt: 'Create an AI team with roles and models',
    ruAlt: 'Создание команды ИИ с ролями и моделями',
    width: 2624,
    height: 1686,
  },
  {
    path: 'screenshots/5.png',
    previewPath: 'screenshots/previews/5.webp',
    alt: 'MCP server catalog and diagnostics',
    ruAlt: 'Каталог и диагностика MCP-серверов',
    width: 2624,
    height: 1650,
  },
  {
    path: 'screenshots/6.png',
    previewPath: 'screenshots/previews/6.webp',
    alt: 'Team notification settings',
    ruAlt: 'Настройки уведомлений команды',
    width: 2622,
    height: 1646,
  },
  {
    path: 'screenshots/7.png',
    previewPath: 'screenshots/previews/7.webp',
    alt: 'Code review with hunk-level controls',
    ruAlt: 'Код-ревью с управлением отдельными изменениями',
    width: 2624,
    height: 1644,
  },
  {
    path: 'screenshots/8.png',
    previewPath: 'screenshots/previews/8.webp',
    alt: 'Task details, attachments, and execution logs',
    ruAlt: 'Детали задачи, вложения и логи выполнения',
    width: 2624,
    height: 1638,
  },
  {
    path: 'screenshots/9.png',
    previewPath: 'screenshots/previews/9.webp',
    alt: 'Agent execution log with tool calls',
    ruAlt: 'Лог выполнения агента с вызовами инструментов',
    width: 2620,
    height: 1642,
  },
];
