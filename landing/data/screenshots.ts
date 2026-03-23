export type Screenshot = {
  src: string;
  alt: string;
  width: number;
  height: number;
};

/**
 * Screenshot definitions for the carousel.
 * `src` is relative to public/ — prepend baseURL at runtime.
 */
export const screenshots: (Omit<Screenshot, "src"> & { path: string })[] = [
  { path: "screenshots/1.jpg", alt: "Kanban board with agent tasks", width: 1920, height: 1080 },
  { path: "screenshots/2.jpg", alt: "Agent team communication", width: 1920, height: 1080 },
  { path: "screenshots/3.png", alt: "Code review diff view", width: 1920, height: 1080 },
  { path: "screenshots/4.png", alt: "Team management dashboard", width: 1920, height: 1080 },
  { path: "screenshots/5.png", alt: "Live process monitoring", width: 1920, height: 1080 },
  { path: "screenshots/6.png", alt: "Session context analysis", width: 1920, height: 1080 },
  { path: "screenshots/7.png", alt: "Cross-team messaging", width: 1920, height: 1080 },
  { path: "screenshots/8.png", alt: "Task details and comments", width: 1920, height: 1080 },
  { path: "screenshots/9.png", alt: "Built-in code editor", width: 1920, height: 1080 },
  { path: "screenshots/10.png", alt: "Task details with code changes and execution logs", width: 2624, height: 1642 },
  { path: "screenshots/11.png", alt: "Agent code review comments and task workflow", width: 2624, height: 1696 },
  { path: "screenshots/12.png", alt: "Allow or deny agent actions with live preview", width: 2624, height: 1646 },
];
