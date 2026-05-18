import robotAmber from "~/assets/images/hero/robots/robot-amber-v1.webp";
import robotCyan from "~/assets/images/hero/robots/robot-cyan-v1.webp";
import robotMagenta from "~/assets/images/hero/robots/robot-magenta-v1.webp";

export const HERO_SCENE_VIEWBOX = {
  width: 1600,
  height: 900,
} as const;

export const HERO_SCENE_BREAKPOINTS = {
  desktop: 1200,
  tablet: 768,
} as const;

export type HeroAgentRole =
  | "planner"
  | "lead"
  | "reviewer"
  | "developer"
  | "tester"
  | "researcher"
  | "docs"
  | "ops"
  | "security"
  | "fixer";

export type HeroAccent = "cyan" | "magenta" | "violet" | "amber" | "red";

export type HeroCardSide = "left" | "right" | "bottom";

export type HeroAgentPosition = {
  x: number;
  y: number;
  scale: number;
  depth: number;
  card: HeroCardSide;
};

export type HeroAgent = {
  id: HeroAgentRole;
  label: string;
  asset: string;
  accent: HeroAccent;
  priority?: boolean;
  desktop: HeroAgentPosition;
  tablet: HeroAgentPosition;
  mobile: {
    visible: boolean;
    order?: number;
    compactLabel?: string;
  };
  status: string;
  tasks: string[];
};

export type HeroConnection = {
  id: string;
  from: HeroAgentRole | "video";
  to: HeroAgentRole | "video";
  accent: Extract<HeroAccent, "cyan" | "magenta" | "amber">;
  pathDesktop: string;
  packetDelayMs: number;
  packetDurationMs: number;
};

export type HeroMessage = {
  id: string;
  from: HeroAgentRole;
  to: HeroAgentRole | "video";
  connectionId: string;
  text: string;
  response: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
};

export const heroAgents: readonly HeroAgent[] = [
  {
    id: "planner",
    label: "Planner",
    asset: robotCyan,
    accent: "cyan",
    priority: true,
    desktop: { x: 34, y: 12, scale: 0.66, depth: 0.35, card: "right" },
    tablet: { x: 18, y: 11, scale: 0.55, depth: 0.22, card: "bottom" },
    mobile: { visible: true, order: 1, compactLabel: "Plan" },
    status: "Planning",
    tasks: ["Analyze requirements", "Break down tasks", "Create plan"],
  },
  {
    id: "lead",
    label: "Lead",
    asset: robotCyan,
    accent: "cyan",
    priority: true,
    desktop: { x: 55, y: 9, scale: 0.62, depth: 0.32, card: "right" },
    tablet: { x: 50, y: 8, scale: 0.52, depth: 0.2, card: "bottom" },
    mobile: { visible: true, order: 2, compactLabel: "Lead" },
    status: "Leading",
    tasks: ["Define architecture", "Set priorities", "Coordinate team"],
  },
  {
    id: "reviewer",
    label: "Reviewer",
    asset: robotMagenta,
    accent: "magenta",
    priority: true,
    desktop: { x: 75, y: 13, scale: 0.58, depth: 0.34, card: "left" },
    tablet: { x: 82, y: 12, scale: 0.48, depth: 0.22, card: "bottom" },
    mobile: { visible: true, order: 3, compactLabel: "Review" },
    status: "Reviewing",
    tasks: ["Review code", "Check quality", "Request changes"],
  },
  {
    id: "researcher",
    label: "Researcher",
    asset: robotCyan,
    accent: "violet",
    desktop: { x: 27, y: 39, scale: 0.48, depth: 0.45, card: "right" },
    tablet: { x: 16, y: 45, scale: 0.44, depth: 0.25, card: "bottom" },
    mobile: { visible: false },
    status: "Researching",
    tasks: ["Research options", "Compare solutions", "Summarize findings"],
  },
  {
    id: "developer",
    label: "Developer",
    asset: robotCyan,
    accent: "cyan",
    desktop: { x: 74, y: 34, scale: 0.5, depth: 0.52, card: "left" },
    tablet: { x: 88, y: 44, scale: 0.42, depth: 0.26, card: "bottom" },
    mobile: { visible: false },
    status: "Coding",
    tasks: ["Write code", "Implement feature", "Commit changes"],
  },
  {
    id: "tester",
    label: "Tester",
    asset: robotMagenta,
    accent: "magenta",
    desktop: { x: 72, y: 59, scale: 0.48, depth: 0.58, card: "left" },
    tablet: { x: 76, y: 77, scale: 0.4, depth: 0.28, card: "bottom" },
    mobile: { visible: false },
    status: "Testing",
    tasks: ["Write tests", "Run tests", "Report issues"],
  },
  {
    id: "docs",
    label: "Docs",
    asset: robotMagenta,
    accent: "violet",
    desktop: { x: 30, y: 64, scale: 0.43, depth: 0.55, card: "right" },
    tablet: { x: 25, y: 78, scale: 0.36, depth: 0.28, card: "bottom" },
    mobile: { visible: false },
    status: "Writing",
    tasks: ["Write docs", "API reference", "Examples"],
  },
  {
    id: "ops",
    label: "Ops",
    asset: robotAmber,
    accent: "amber",
    desktop: { x: 43, y: 84, scale: 0.46, depth: 0.7, card: "right" },
    tablet: { x: 42, y: 83, scale: 0.38, depth: 0.34, card: "bottom" },
    mobile: { visible: false },
    status: "Deploying",
    tasks: ["Deploy services", "Monitor health", "Manage infra"],
  },
  {
    id: "security",
    label: "Security",
    asset: robotAmber,
    accent: "red",
    desktop: { x: 63, y: 85, scale: 0.42, depth: 0.68, card: "right" },
    tablet: { x: 60, y: 82, scale: 0.34, depth: 0.32, card: "bottom" },
    mobile: { visible: false },
    status: "Secure",
    tasks: ["Scan dependencies", "Check permissions", "Security review"],
  },
  {
    id: "fixer",
    label: "Fixer",
    asset: robotAmber,
    accent: "amber",
    desktop: { x: 69, y: 83, scale: 0.42, depth: 0.72, card: "left" },
    tablet: { x: 90, y: 82, scale: 0.36, depth: 0.34, card: "bottom" },
    mobile: { visible: false },
    status: "Fixing",
    tasks: ["Fix issues", "Refactor code", "Optimize"],
  },
] as const;

export const heroConnections: readonly HeroConnection[] = [
  {
    id: "planner-lead",
    from: "planner",
    to: "lead",
    accent: "cyan",
    pathDesktop: "M 545 195 C 680 210, 735 185, 860 190",
    packetDelayMs: 0,
    packetDurationMs: 4200,
  },
  {
    id: "lead-reviewer",
    from: "lead",
    to: "reviewer",
    accent: "magenta",
    pathDesktop: "M 950 205 C 1050 185, 1130 190, 1265 220",
    packetDelayMs: 700,
    packetDurationMs: 3900,
  },
  {
    id: "developer-reviewer",
    from: "developer",
    to: "reviewer",
    accent: "magenta",
    pathDesktop: "M 1390 370 C 1325 320, 1305 270, 1260 230",
    packetDelayMs: 500,
    packetDurationMs: 3400,
  },
  {
    id: "researcher-video",
    from: "researcher",
    to: "video",
    accent: "cyan",
    pathDesktop: "M 520 425 C 625 410, 680 405, 755 420",
    packetDelayMs: 1100,
    packetDurationMs: 4400,
  },
  {
    id: "video-tester",
    from: "video",
    to: "tester",
    accent: "magenta",
    pathDesktop: "M 1290 540 C 1365 555, 1410 575, 1480 615",
    packetDelayMs: 1300,
    packetDurationMs: 4100,
  },
  {
    id: "tester-lead",
    from: "tester",
    to: "lead",
    accent: "cyan",
    pathDesktop: "M 1450 625 C 1365 650, 1170 642, 1030 630 C 940 620, 880 585, 850 515",
    packetDelayMs: 1800,
    packetDurationMs: 5200,
  },
  {
    id: "ops-security",
    from: "ops",
    to: "security",
    accent: "amber",
    pathDesktop: "M 745 740 C 835 725, 910 725, 1000 742",
    packetDelayMs: 2200,
    packetDurationMs: 4600,
  },
  {
    id: "security-fixer",
    from: "security",
    to: "fixer",
    accent: "amber",
    pathDesktop: "M 1100 745 C 1185 725, 1270 730, 1375 755",
    packetDelayMs: 2600,
    packetDurationMs: 4600,
  },
] as const;

export const heroMessages: readonly HeroMessage[] = [
  {
    id: "code-review",
    from: "developer",
    to: "reviewer",
    connectionId: "developer-reviewer",
    text: "Code ready. Request review.",
    response: "Review started.",
    fromX: 78,
    fromY: 43,
    toX: 73,
    toY: 20,
  },
  {
    id: "tests-passed",
    from: "tester",
    to: "lead",
    connectionId: "tester-lead",
    text: "Tests passed. Looks good.",
    response: "Ship it.",
    fromX: 78,
    fromY: 62,
    toX: 58,
    toY: 21,
  },
  {
    id: "research-ready",
    from: "researcher",
    to: "video",
    connectionId: "researcher-video",
    text: "Findings ready.",
    response: "Plan updated.",
    fromX: 32,
    fromY: 45,
    toX: 50,
    toY: 53,
  },
  {
    id: "ops-secure",
    from: "ops",
    to: "security",
    connectionId: "ops-security",
    text: "Deployed to staging.",
    response: "Dependencies checked.",
    fromX: 44,
    fromY: 72,
    toX: 62,
    toY: 74,
  },
] as const;

export const heroFeatureRail = [
  {
    id: "autonomous",
    title: "Autonomous Team",
    text: "Specialized agents coordinate work together.",
  },
  {
    id: "kanban",
    title: "Kanban at Lightspeed",
    text: "Tasks move as agents build, review, and test.",
  },
  {
    id: "developers",
    title: "Built for Developers",
    text: "Open source, extensible, and API-first.",
  },
  {
    id: "secure",
    title: "Secure by Default",
    text: "Your code and data stay protected.",
  },
  {
    id: "local",
    title: "Local First",
    text: "Runs on your machine. Your data stays yours.",
  },
] as const;
