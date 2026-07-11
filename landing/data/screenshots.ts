export type Screenshot = {
  src: string;
  alt: string;
  ruAlt?: string;
  width: number;
  height: number;
};

/**
 * Screenshot definitions for the carousel.
 * `src` is served from the repository-level docs/screenshots directory.
 */
export const screenshots: (Omit<Screenshot, "src"> & { path: string })[] = [
  { path: "screenshots/1.jpg", alt: "Kanban board with agent tasks", ruAlt: "Канбан-доска с задачами агентов", width: 1920, height: 1080 },
  { path: "screenshots/2.jpg", alt: "Live teammate status and resource usage", ruAlt: "Статусы участников команды и использование ресурсов", width: 1920, height: 1080 },
  { path: "screenshots/3.png", alt: "Task discussion and review comments", ruAlt: "Обсуждение задачи и комментарии ревью", width: 1920, height: 1080 },
  { path: "screenshots/4.png", alt: "Create an AI team with roles and models", ruAlt: "Создание команды ИИ с ролями и моделями", width: 1920, height: 1080 },
  { path: "screenshots/5.png", alt: "MCP server catalog and diagnostics", ruAlt: "Каталог и диагностика MCP-серверов", width: 1920, height: 1080 },
  { path: "screenshots/6.png", alt: "Team notification settings", ruAlt: "Настройки уведомлений команды", width: 1920, height: 1080 },
  { path: "screenshots/7.png", alt: "Code review with hunk-level controls", ruAlt: "Код-ревью с управлением отдельными изменениями", width: 1920, height: 1080 },
  { path: "screenshots/8.png", alt: "Task details, attachments, and execution logs", ruAlt: "Детали задачи, вложения и логи выполнения", width: 1920, height: 1080 },
  { path: "screenshots/9.png", alt: "Agent execution log with tool calls", ruAlt: "Лог выполнения агента с вызовами инструментов", width: 1920, height: 1080 },
  { path: "screenshots/10.png", alt: "Provider connections and model availability", ruAlt: "Подключения провайдеров и доступные модели", width: 2624, height: 1642 },
];
