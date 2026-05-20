export type Screenshot = {
  src: string;
  alt: string;
  ruAlt?: string;
  width: number;
  height: number;
};

/**
 * Screenshot definitions for the carousel.
 * `src` is relative to public/ — prepend baseURL at runtime.
 */
export const screenshots: (Omit<Screenshot, "src"> & { path: string })[] = [
  { path: "screenshots/1.jpg", alt: "Kanban board with agent tasks", ruAlt: "Канбан-доска с задачами агентов", width: 1920, height: 1080 },
  { path: "screenshots/2.jpg", alt: "Agent team communication", ruAlt: "Коммуникация команды агентов", width: 1920, height: 1080 },
  { path: "screenshots/3.png", alt: "Code review diff view", ruAlt: "Diff-просмотр для код-ревью", width: 1920, height: 1080 },
  { path: "screenshots/4.png", alt: "Team management dashboard", ruAlt: "Панель управления командой", width: 1920, height: 1080 },
  { path: "screenshots/5.png", alt: "Live process monitoring", ruAlt: "Мониторинг живых процессов", width: 1920, height: 1080 },
  { path: "screenshots/6.png", alt: "Session context analysis", ruAlt: "Анализ контекста сессии", width: 1920, height: 1080 },
  { path: "screenshots/7.png", alt: "Cross-team messaging", ruAlt: "Сообщения между командами", width: 1920, height: 1080 },
  { path: "screenshots/8.png", alt: "Task details and comments", ruAlt: "Детали задачи и комментарии", width: 1920, height: 1080 },
  { path: "screenshots/9.png", alt: "Built-in code editor", ruAlt: "Встроенный редактор кода", width: 1920, height: 1080 },
  { path: "screenshots/10.png", alt: "Task details with code changes and execution logs", ruAlt: "Детали задачи с изменениями кода и логами выполнения", width: 2624, height: 1642 },
  { path: "screenshots/11.png", alt: "Agent code review comments and task workflow", ruAlt: "Комментарии агента к код-ревью и процессу задачи", width: 2624, height: 1696 },
  { path: "screenshots/12.png", alt: "Allow or deny agent actions with live preview", ruAlt: "Разрешение или запрет действий агента с предпросмотром", width: 2624, height: 1646 },
];
