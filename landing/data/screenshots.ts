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
    path: 'screenshots/1.png',
    previewPath: 'screenshots/previews/1.webp',
    alt: 'Kanban board with agent tasks and team messages',
    ruAlt: 'Канбан-доска с задачами агентов и сообщениями команды',
    width: 2624,
    height: 1652,
  },
  {
    path: 'screenshots/2.png',
    previewPath: 'screenshots/previews/2.webp',
    alt: 'Organization hierarchy with teams, agents, and active tasks',
    ruAlt: 'Иерархия организации с командами, агентами и активными задачами',
    width: 2624,
    height: 1634,
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
    path: 'screenshots/4.jpg',
    previewPath: 'screenshots/previews/4.webp',
    alt: 'Create an AI team with roles, providers, and models',
    ruAlt: 'Создание команды ИИ с ролями, провайдерами и моделями',
    width: 2560,
    height: 1552,
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
    alt: 'Responsive team notification settings and built-in triggers',
    ruAlt: 'Адаптивные настройки уведомлений команды и встроенные триггеры',
    width: 2624,
    height: 1640,
  },
  {
    path: 'screenshots/7.png',
    previewPath: 'screenshots/previews/7.webp',
    alt: 'Code review with file-level and hunk-level controls',
    ruAlt: 'Код-ревью с управлением файлами и отдельными изменениями',
    width: 2624,
    height: 1648,
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
