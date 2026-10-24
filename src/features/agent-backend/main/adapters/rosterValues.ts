import type {
  BackendRosterReplacement,
  BackendRosterSettings,
  BackendSavedTeamSettings,
} from '../../contracts/roster';

export function rosterRow(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== null &&
      Object.getPrototypeOf(Object.getPrototypeOf(value)) !== null) ||
    (allowed && Object.keys(value).some((key) => !allowed.includes(key)))
  )
    throw new Error('Invalid roster');
  // Own data only, including values cloned across an IPC/test realm.
  return Object.fromEntries(Object.entries(value));
}
export function rosterText(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0'))
    throw new Error('Invalid roster text');
  return value;
}
export function rosterName(value: unknown): string {
  const name = rosterText(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name)) throw new Error('Invalid roster name');
  return name;
}
export function rosterRevision(value: unknown): string {
  const revision = rosterText(value, 64);
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('Invalid roster revision');
  return revision;
}
function choice<const T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new Error('Invalid roster choice');
  return value as T;
}
const settingsKeys = [
  'role',
  'workflow',
  'isolation',
  'cwd',
  'providerId',
  'providerBackendId',
  'model',
  'effort',
  'fastMode',
  'mcpPolicy',
] as const;

/** Same finite value vocabulary for strict input capture and allowlisted output projection. */
export function rosterSettings(value: unknown, strict: boolean): BackendRosterSettings {
  const source = rosterRow(value, strict ? settingsKeys : undefined);
  const result: BackendRosterSettings = {};
  for (const [key, max] of [
    ['role', 256],
    ['workflow', 64 * 1024],
    ['cwd', 8192],
    ['model', 256],
  ] as const) {
    if (source[key] !== undefined) {
      const text = rosterText(source[key], max).trim();
      if (!text) throw new Error('Invalid roster setting');
      result[key] = text;
    }
  }
  if (source.isolation !== undefined) result.isolation = choice(source.isolation, ['worktree']);
  if (source.providerId !== undefined)
    result.providerId = choice(source.providerId, ['anthropic', 'codex', 'gemini', 'opencode']);
  if (source.providerBackendId !== undefined)
    result.providerBackendId = choice(source.providerBackendId, [
      'auto',
      'adapter',
      'api',
      'cli-sdk',
      'codex-native',
      'opencode-cli',
    ]);
  if (source.effort !== undefined)
    result.effort = choice(source.effort, [
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
  if (source.fastMode !== undefined)
    result.fastMode = choice(source.fastMode, ['inherit', 'on', 'off']);
  if (source.mcpPolicy !== undefined) {
    const policy = rosterRow(
      source.mcpPolicy,
      strict ? ['mode', 'scopes', 'serverNames'] : undefined
    );
    const mapped: NonNullable<BackendRosterSettings['mcpPolicy']> = {
      mode: choice(policy.mode, ['inheritLead', 'inheritScopes', 'strictAllowlist', 'appOnly']),
    };
    if (policy.scopes !== undefined) {
      const scopes = rosterRow(policy.scopes, strict ? ['user', 'project', 'local'] : undefined);
      mapped.scopes = {};
      for (const key of ['user', 'project', 'local'] as const)
        if (scopes[key] !== undefined) {
          if (typeof scopes[key] !== 'boolean') throw new Error('Invalid MCP scope');
          mapped.scopes[key] = scopes[key];
        }
    }
    if (policy.serverNames !== undefined) {
      if (!Array.isArray(policy.serverNames) || policy.serverNames.length > 256)
        throw new Error('Invalid MCP names');
      mapped.serverNames = Array.from(policy.serverNames, (value) => {
        const name = rosterText(value).trim();
        if (!name) throw new Error('Invalid MCP name');
        return name;
      });
    }
    result.mcpPolicy = mapped;
  }
  return result;
}

/** Preserve configured defaults and literal prompt/args text; never copy native profile fields. */
export function rosterSavedSettings(value: unknown, strict: boolean): BackendSavedTeamSettings {
  const selections = ['providerId', 'providerBackendId', 'model', 'effort', 'fastMode'] as const;
  const strings = [
    ['cwd', 8192],
    ['displayName', 256],
    ['description', 64 * 1024],
    ['color', 256],
    ['prompt', 64 * 1024],
    ['worktree', 256],
    ['extraCliArgs', 64 * 1024],
  ] as const;
  const booleans = [
    'syncModelsWithLead',
    'limitContext',
    'skipPermissions',
    'allowExperimentalLocalModels',
  ] as const;
  const source = rosterRow(
    value,
    strict
      ? ['runtimeSelectionVersion', ...selections, ...strings.map(([key]) => key), ...booleans]
      : undefined
  );
  const cwd = rosterText(source.cwd, 8192);
  if (!cwd.trim()) throw new Error('Invalid saved workspace');
  const result: BackendSavedTeamSettings = {
    cwd,
    ...rosterSettings(
      Object.fromEntries(
        selections.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])
      ),
      true
    ),
  };
  if (source.runtimeSelectionVersion !== undefined) {
    if (source.runtimeSelectionVersion !== 1) throw new Error('Invalid runtime selection version');
    result.runtimeSelectionVersion = 1;
  }
  for (const [key, max] of strings)
    if (source[key] !== undefined) {
      const value = source[key];
      if (typeof value !== 'string' || value.length > max || value.includes('\0'))
        throw new Error('Invalid saved text');
      result[key] = value;
    }
  for (const key of booleans)
    if (source[key] !== undefined) {
      if (typeof source[key] !== 'boolean') throw new Error('Invalid saved flag');
      result[key] = source[key];
    }
  return result;
}

export function parseRosterReplacement(value: unknown): BackendRosterReplacement {
  const source = rosterRow(value, [
    'expectedRevision',
    'members',
    'savedSettings',
    'memberSettingsRelaunch',
  ]);
  if (!Array.isArray(source.members) || source.members.length > 255)
    throw new Error('Invalid roster members');
  let bytes = 0;
  const members = Array.from(source.members, (value) => {
    const member = rosterRow(value, ['name', ...settingsKeys]);
    const { name, ...settings } = member;
    const captured = { name: rosterName(name), ...rosterSettings(settings, true) };
    bytes += Buffer.byteLength(JSON.stringify(captured));
    if (bytes > 256 * 1024) throw new Error('Oversized roster');
    return captured;
  });
  if (new Set(members.map((member) => member.name.toLowerCase())).size !== members.length)
    throw new Error('Duplicate roster member');
  const result: BackendRosterReplacement = {
    expectedRevision: rosterRevision(source.expectedRevision),
    members,
    ...(source.savedSettings === undefined
      ? {}
      : { savedSettings: rosterSavedSettings(source.savedSettings, true) }),
    ...(source.memberSettingsRelaunch === undefined
      ? {}
      : {
          memberSettingsRelaunch: rosterMemberSettingsIntent(source.memberSettingsRelaunch),
        }),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new Error('Oversized roster');
  return result;
}

function rosterMemberSettingsIntent(
  value: unknown
): NonNullable<BackendRosterReplacement['memberSettingsRelaunch']> {
  const source = rosterRow(value, [
    'memberName',
    'targetKind',
    'expectedFingerprint',
    'expectedTeamSettingsFingerprint',
    'baseline',
    'model',
    'effort',
  ]);
  if (!Array.isArray(source.baseline) || source.baseline.length < 1 || source.baseline.length > 256)
    throw new Error('Invalid member settings baseline');
  const baseline = Array.from(source.baseline, (value) => {
    const row = rosterRow(value, ['memberName', 'expectedFingerprint']);
    return {
      memberName: rosterName(row.memberName),
      expectedFingerprint: rosterRevision(row.expectedFingerprint),
    };
  });
  if (new Set(baseline.map((row) => row.memberName)).size !== baseline.length)
    throw new Error('Duplicate member settings baseline');
  const model = source.model === null ? null : rosterText(source.model).trim();
  if (model !== null && !model) throw new Error('Invalid member settings model');
  return {
    memberName: rosterName(source.memberName),
    targetKind: choice(source.targetKind, ['lead', 'member']),
    expectedFingerprint: rosterRevision(source.expectedFingerprint),
    expectedTeamSettingsFingerprint: rosterRevision(source.expectedTeamSettingsFingerprint),
    baseline,
    model,
    effort:
      source.effort === null
        ? null
        : choice(source.effort, [
            'none',
            'minimal',
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
            'ultra',
          ]),
  };
}
