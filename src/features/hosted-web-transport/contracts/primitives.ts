export const HOSTED_WEB_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

export type HostedWebEffortLevel = (typeof HOSTED_WEB_EFFORT_LEVELS)[number];

export const HOSTED_WEB_TEAM_PROVIDER_IDS = ['anthropic', 'codex', 'gemini', 'opencode'] as const;

export type HostedWebTeamProviderId = (typeof HOSTED_WEB_TEAM_PROVIDER_IDS)[number];

export const HOSTED_WEB_TEAM_FAST_MODES = ['inherit', 'on', 'off'] as const;

export type HostedWebTeamFastMode = (typeof HOSTED_WEB_TEAM_FAST_MODES)[number];

export const HOSTED_WEB_TEAM_TASK_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'deleted',
] as const;

export type HostedWebTeamTaskStatus = (typeof HOSTED_WEB_TEAM_TASK_STATUSES)[number];

export const HOSTED_WEB_TEAM_REVIEW_STATES = ['none', 'review', 'needsFix', 'approved'] as const;

export type HostedWebTeamReviewState = (typeof HOSTED_WEB_TEAM_REVIEW_STATES)[number];

export const HOSTED_WEB_PROVISIONING_STATES = [
  'validating',
  'spawning',
  'configuring',
  'assembling',
  'finalizing',
  'verifying',
  'ready',
  'disconnected',
  'failed',
  'cancelled',
] as const;

export type HostedWebProvisioningState = (typeof HOSTED_WEB_PROVISIONING_STATES)[number];
