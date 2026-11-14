export type Screenshot = {
  path: string;
  previewPath: string;
  alt: string;
  ruAlt?: string;
  width: number;
  height: number;
  version?: string;
};

/**
 * Screenshot definitions for the carousel.
 * Full-size images and their previews are served from the repository-level
 * docs/screenshots directory.
 */
export const screenshots: Screenshot[] = [
  {
    path: 'screenshots/task-detail-animated.gif',
    previewPath: 'screenshots/previews/task-detail-animated.gif',
    alt: 'Agent graph showing messages, activity, and task progress',
    ruAlt: 'Граф агентов: сообщения, активность и движение задач',
    width: 1600,
    height: 1066,
  },
  {
    path: 'screenshots/team-chat.png',
    previewPath: 'screenshots/previews/team-chat.webp',
    alt: 'Group chats with replies, attachments, an inline chart, and archived conversations',
    ruAlt: 'Групповые чаты с ответами, вложениями, диаграммой и архивом',
    width: 2250,
    height: 1650,
  },
  {
    path: 'screenshots/1.png',
    previewPath: 'screenshots/previews/1.webp',
    alt: 'Kanban board with team messages and agent tasks',
    ruAlt: 'Канбан-доска с сообщениями команды и задачами агентов',
    width: 2250,
    height: 1500,
  },
  {
    path: 'screenshots/14.png',
    previewPath: 'screenshots/previews/14.webp',
    alt: 'Token usage, costs, runs, and budget analytics',
    ruAlt: 'Аналитика токенов, расходов, запусков и бюджетов',
    width: 1312,
    height: 900,
    version: '1cff3f1128ca',
  },
  {
    path: 'screenshots/15.png',
    previewPath: 'screenshots/previews/15.webp',
    alt: 'Select AI providers and models for each teammate',
    ruAlt: 'Выбор AI-провайдеров и моделей для каждого участника команды',
    width: 2250,
    height: 1650,
  },
  {
    path: 'screenshots/13.png',
    previewPath: 'screenshots/previews/13.webp',
    alt: 'Provider settings with connected AI coding services and available plans',
    ruAlt: 'Настройки подключённых AI-провайдеров и доступных подписок',
    width: 2250,
    height: 1650,
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
    path: 'screenshots/4.png',
    previewPath: 'screenshots/previews/4.webp',
    alt: 'Built-in terminal running checks and a local development server',
    ruAlt: 'Встроенный терминал с проверками и локальным сервером разработки',
    width: 2250,
    height: 1650,
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
    alt: 'Notification settings and automatic agent recovery',
    ruAlt: 'Настройки уведомлений и автоматического восстановления агентов',
    width: 1500,
    height: 900,
  },
  {
    path: 'screenshots/7.png',
    previewPath: 'screenshots/previews/7.webp',
    alt: 'Code review with file-level and hunk-level controls',
    ruAlt: 'Код-ревью с управлением файлами и отдельными изменениями',
    width: 2250,
    height: 1650,
  },
  {
    path: 'screenshots/8.png',
    previewPath: 'screenshots/previews/8.webp',
    alt: 'Task details, attachments, and execution logs',
    ruAlt: 'Детали задачи, вложения и логи выполнения',
    width: 2250,
    height: 1650,
  },
  {
    path: 'screenshots/9.png',
    previewPath: 'screenshots/previews/9.webp',
    alt: 'Agent execution log with tool calls',
    ruAlt: 'Лог выполнения агента с вызовами инструментов',
    width: 2250,
    height: 1650,
  },
  {
    // Carousel uses the compressed preview; full PNG loads only on lightbox demand.
    path: 'screenshots/organization-map.png',
    previewPath: 'screenshots/previews/organization-map.webp',
    alt: 'Organization structure map with team and task details',
    ruAlt: 'Карта структуры организации с командами и деталями задач',
    width: 2624,
    height: 1648,
  },
];
