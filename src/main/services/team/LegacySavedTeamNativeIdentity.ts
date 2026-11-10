type Row = Record<string, unknown>;
const nativeKey =
  /^(agentId|leadAgentId|sessionId|leadSessionId|sessionHistory|runtimeSessionId|nativeSessionId|threadId|runId|pid|runtimePid|backendPid|processId|tmuxPaneId|tmuxSession|paneId|runtimeLeaseExpiresAt)$/i;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function isLegacyNativeIdentityKey(key: string): boolean {
  return nativeKey.test(key);
}
function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid saved Team');
  return value as Row;
}
function named(value: unknown): Row {
  const member = row(value);
  if (typeof member.name !== 'string' || !namePattern.test(member.name))
    throw new Error('Invalid saved member');
  return member;
}

/** Static records only. Empty identity does not establish release, ownership, or an empty artifact census. */
export function classifyLegacySavedTeamNativeRecords(
  teamName: string,
  records: { config: unknown | null; meta: unknown; roster: unknown }
): 'empty' | 'retained' | 'unknown' {
  try {
    if (!namePattern.test(teamName)) return 'unknown';
    const config = records.config === null ? null : row(records.config),
      meta = row(records.meta),
      roster = row(records.roster);
    if (
      meta.version !== 1 ||
      roster.version !== 1 ||
      !Array.isArray(roster.members) ||
      (config && (config.name !== teamName || !Array.isArray(config.members)))
    )
      return 'unknown';
    const members = roster.members.map(named);
    const configured = config ? (config.members as unknown[]).map(named) : [];
    if (
      [members, configured].some(
        (rows) =>
          new Set(rows.map((member) => String(member.name).toLowerCase())).size !== rows.length
      )
    )
      return 'unknown';
    const leads = config
      ? configured.filter((member) => member.agentType === 'team-lead')
      : [{ name: 'team-lead' }];
    if (leads.length !== 1 || (!config && members.some((member) => member.name === 'team-lead')))
      return 'unknown';
    const leadName = leads[0].name as string;
    const names = new Set([leadName, ...members.map((member) => member.name)]);
    const productIds = new Map<object, string>();
    for (const member of [...members, ...configured]) {
      if (names.has(member.name)) productIds.set(member, `${String(member.name)}@${teamName}`);
    }
    const nativeIdentity = (value: unknown, depth = 0): boolean => {
      if (depth > 64) return true;
      if (Array.isArray(value)) return value.some((item) => nativeIdentity(item, depth + 1));
      if (!value || typeof value !== 'object') return false;
      return Object.entries(value).some(
        ([key, item]) =>
          (isLegacyNativeIdentityKey(key) &&
            item !== undefined &&
            item !== null &&
            item !== '' &&
            !(key === 'agentId' && productIds.get(value) === item) &&
            !(key === 'leadAgentId' && value === config && item === `${leadName}@${teamName}`) &&
            !(key === 'sessionHistory' && Array.isArray(item) && item.length === 0)) ||
          nativeIdentity(item, depth + 1)
      );
    };
    return [config, meta, roster].some((value) => nativeIdentity(value)) ? 'retained' : 'empty';
  } catch {
    return 'unknown';
  }
}

const metaText = new Set([
  'displayName',
  'description',
  'color',
  'cwd',
  'prompt',
  'providerId',
  'providerBackendId',
  'model',
  'effort',
  'fastMode',
  'worktree',
  'extraCliArgs',
]);
const metaBooleans = new Set(['syncModelsWithLead', 'skipPermissions', 'limitContext']);
const memberText = new Set([
  'name',
  'agentId',
  'agentType',
  'role',
  'workflow',
  'isolation',
  'providerId',
  'providerBackendId',
  'model',
  'effort',
  'fastMode',
  'color',
  'cwd',
]);
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 * 1024 && !value.includes('\0');
}
function timestamp(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function policy(value: unknown): boolean {
  const source = row(value);
  if (!['inheritLead', 'inheritScopes', 'strictAllowlist', 'appOnly'].includes(String(source.mode)))
    return false;
  return Object.entries(source).every(([key, item]) => {
    if (key === 'mode') return true;
    if (key === 'serverNames') return Array.isArray(item) && item.length <= 128 && item.every(text);
    if (key === 'scopes')
      return Object.entries(row(item)).every(
        ([scope, flag]) => ['user', 'project', 'local'].includes(scope) && typeof flag === 'boolean'
      );
    return false;
  });
}
function productMember(value: unknown): boolean {
  const member = named(value);
  return Object.entries(member).every(([key, item]) => {
    if (memberText.has(key)) return text(item);
    if (key === 'joinedAt' || key === 'removedAt') return timestamp(item);
    if (key === 'mcpPolicy') return policy(item);
    return false;
  });
}

/** Finite saved-product forms only; caller must also prove empty native files and owner obligations. */
export function isLegacySavedTeamProductRecords(
  teamName: string,
  records: { config: unknown | null; meta: unknown; roster: unknown }
): boolean {
  try {
    if (classifyLegacySavedTeamNativeRecords(teamName, records) !== 'empty') return false;
    const meta = row(records.meta),
      roster = row(records.roster);
    if (
      !text(meta.cwd) ||
      !timestamp(meta.createdAt) ||
      !Object.entries(meta).every(([key, item]) => {
        if (key === 'version') return item === 1;
        if (key === 'createdAt') return timestamp(item);
        if (metaText.has(key)) return text(item);
        if (metaBooleans.has(key)) return typeof item === 'boolean';
        return false;
      })
    )
      return false;
    if (
      !Object.entries(roster).every(([key, item]) =>
        key === 'version'
          ? item === 1
          : key === 'providerBackendId'
            ? text(item)
            : key === 'members' &&
              Array.isArray(item) &&
              item.length <= 128 &&
              item.every(productMember)
      )
    )
      return false;
    if (records.config === null) return true;
    return Object.entries(row(records.config)).every(([key, item]) => {
      if (['name', 'description', 'projectPath', 'leadAgentId'].includes(key)) return text(item);
      if (key === 'createdAt') return timestamp(item);
      if (key === 'members')
        return Array.isArray(item) && item.length <= 128 && item.every(productMember);
      return false;
    });
  } catch {
    return false;
  }
}
