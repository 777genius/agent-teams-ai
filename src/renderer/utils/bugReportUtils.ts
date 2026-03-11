import packageJson from '../../../package.json';

const GITHUB_BUG_REPORT_URL = 'https://github.com/777genius/claude_agent_teams_ui/issues/new';
const MAX_TITLE_LENGTH = 120;
const URL_MAX_STACK_LENGTH = 1800;
const URL_MAX_COMPONENT_STACK_LENGTH = 1200;
const COPY_MAX_STACK_LENGTH = 12000;
const COPY_MAX_COMPONENT_STACK_LENGTH = 8000;

export interface BugReportContext {
  activeTabType?: string | null;
  activeTabLabel?: string | null;
  activeTeamName?: string | null;
  selectedTeamName?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
}

export interface BugReportOptions {
  error: Error | null;
  componentStack?: string | null;
  context?: BugReportContext;
}

const truncate = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated]`;
};

const buildIssueTitle = (error: Error | null): string => {
  const baseTitle = error ? `[BUG] ${error.name}: ${error.message}` : '[BUG] Application crash';
  return truncate(baseTitle, MAX_TITLE_LENGTH);
};

const getRuntimeLabel = (): string => (window.electronAPI ? 'Electron renderer' : 'Web browser');

const formatOptional = (value: string | null | undefined): string => {
  if (!value) {
    return 'Not available';
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'Not available';
};

const getOperatingSystemLabel = (): string => {
  const { userAgent } = window.navigator;

  if (userAgent.includes('Mac OS X')) return 'macOS';
  if (userAgent.includes('Windows')) return 'Windows';
  if (userAgent.includes('Linux')) return 'Linux';

  return 'Unknown';
};

const formatActiveTab = (context?: BugReportContext): string => {
  if (!context?.activeTabType) {
    return 'Not available';
  }

  if (!context.activeTabLabel) {
    return context.activeTabType;
  }

  return `${context.activeTabType} (${context.activeTabLabel})`;
};

const buildBugReportMarkdown = (
  { error, componentStack, context }: BugReportOptions,
  stackLimits: { js: number; react: number }
): string => {
  const message = error?.message ?? 'Unknown application crash';
  const jsStack = error?.stack ? truncate(error.stack, stackLimits.js) : 'Not available';
  const reactComponentStack = componentStack
    ? truncate(componentStack, stackLimits.react)
    : 'Not available';

  return [
    '**Describe the bug**',
    'The app crashed and showed the global error screen.',
    '',
    '**What happened**',
    `- Error: \`${message}\``,
    `- Error type: \`${error?.name ?? 'UnknownError'}\``,
    `- Active tab: ${formatActiveTab(context)}`,
    `- Active team tab: ${formatOptional(context?.activeTeamName)}`,
    `- Selected team: ${formatOptional(context?.selectedTeamName)}`,
    `- Current task: ${formatOptional(context?.taskId)}`,
    `- Session ID: ${formatOptional(context?.sessionId)}`,
    `- Project ID: ${formatOptional(context?.projectId)}`,
    '',
    '**Steps to reproduce**',
    '1. Open the app and navigate to the screen where the crash happened.',
    '2. Repeat the action that triggered the error.',
    '3. Observe the global error screen.',
    '',
    '**Expected behavior**',
    'The app should continue working instead of crashing.',
    '',
    '**Screenshots**',
    'Attach a screenshot if you have one.',
    '',
    '**Environment**',
    `- OS: ${getOperatingSystemLabel()}`,
    `- Runtime: ${getRuntimeLabel()}`,
    `- App version: ${packageJson.version}`,
    '',
    '**Diagnostics**',
    '```text',
    `Timestamp: ${new Date().toISOString()}`,
    `Current URL: ${window.location.href}`,
    `User Agent: ${window.navigator.userAgent}`,
    `Error name: ${error?.name ?? 'UnknownError'}`,
    `Error message: ${message}`,
    `Active tab: ${formatActiveTab(context)}`,
    `Active team tab: ${formatOptional(context?.activeTeamName)}`,
    `Selected team: ${formatOptional(context?.selectedTeamName)}`,
    `Current task: ${formatOptional(context?.taskId)}`,
    `Session ID: ${formatOptional(context?.sessionId)}`,
    `Project ID: ${formatOptional(context?.projectId)}`,
    '```',
    '',
    '**JavaScript stack trace**',
    '```text',
    jsStack,
    '```',
    '',
    '**React component stack**',
    '```text',
    reactComponentStack,
    '```',
  ].join('\n');
};

export const buildBugReportText = (options: BugReportOptions): string =>
  buildBugReportMarkdown(options, {
    js: COPY_MAX_STACK_LENGTH,
    react: COPY_MAX_COMPONENT_STACK_LENGTH,
  });

export const buildGitHubBugReportUrl = (options: BugReportOptions): string => {
  const params = new URLSearchParams({
    template: 'bug_report.md',
    labels: 'bug',
    title: buildIssueTitle(options.error),
    body: buildBugReportMarkdown(options, {
      js: URL_MAX_STACK_LENGTH,
      react: URL_MAX_COMPONENT_STACK_LENGTH,
    }),
  });

  return `${GITHUB_BUG_REPORT_URL}?${params.toString()}`;
};
