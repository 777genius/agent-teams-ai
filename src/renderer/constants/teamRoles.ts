/** Preset role options shown in role selectors (Add Member, Create Team, Role Editor). */
export const PRESET_ROLES = [
  'architect',
  'reviewer',
  'developer',
  'qa',
  'researcher',
  'docs',
  'auditor',
  'optimizer',
] as const;

/** Sentinel value for "custom role" in select dropdowns. */
export const CUSTOM_ROLE = '__custom__';

/** Sentinel value for "no role" in select dropdowns. */
export const NO_ROLE = '__none__';

/** Roles that cannot be assigned manually (reserved for system use). */
export const FORBIDDEN_ROLES = new Set(['lead', 'team-lead', 'orchestrator']);
