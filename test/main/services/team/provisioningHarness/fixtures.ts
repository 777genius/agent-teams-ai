import type { TeamMetaFile } from '@main/services/team/TeamMetaStore';
import type { TeamConfig, TeamCreateRequest, TeamMember, TeamProviderId } from '@shared/types';

export const HARNESS_DEFAULT_TEAM_NAME = 'harness-team';
export const HARNESS_DEFAULT_NOW_ISO = '2026-01-01T00:00:00.000Z';
export const HARNESS_INERT_PROJECT_PATH = '/tmp/agent-teams-harness/project';
export const HARNESS_INERT_MODEL = 'harness-model';
export const HARNESS_INERT_PROVIDER_BACKEND_ID = 'adapter';

export type MemberFixtureOptions = Partial<TeamMember>;

function member(
  name: string,
  providerId: TeamProviderId,
  role: string,
  overrides: MemberFixtureOptions = {}
): TeamMember {
  const fixture: TeamMember = {
    name,
    role,
    providerId,
    providerBackendId: HARNESS_INERT_PROVIDER_BACKEND_ID,
    model: HARNESS_INERT_MODEL,
    ...overrides,
  };
  assertNoSecretLikeFixtureValues(fixture);
  return fixture;
}

export const memberFixture = {
  lead(overrides: MemberFixtureOptions = {}): TeamMember {
    return member('Lead', 'codex', 'Team Lead', overrides);
  },

  codex(name: string, overrides: MemberFixtureOptions = {}): TeamMember {
    return member(name, 'codex', 'Engineer', overrides);
  },

  anthropic(name: string, overrides: MemberFixtureOptions = {}): TeamMember {
    return member(name, 'anthropic', 'Engineer', overrides);
  },

  opencode(name: string, overrides: MemberFixtureOptions = {}): TeamMember {
    return member(name, 'opencode', 'Engineer', overrides);
  },
};

export type TeamConfigFixtureOptions = Partial<TeamConfig> & {
  teamName?: string;
};

export const teamConfigFixture = {
  basic(options: TeamConfigFixtureOptions = {}): TeamConfig {
    const {
      teamName = HARNESS_DEFAULT_TEAM_NAME,
      members = [memberFixture.lead(), memberFixture.codex('Builder')],
      projectPath = HARNESS_INERT_PROJECT_PATH,
      ...overrides
    } = options;

    const fixture: TeamConfig = {
      name: overrides.name ?? teamName,
      description: 'Harness fixture team',
      color: 'blue',
      projectPath,
      leadSessionId: 'harness-lead-session',
      members,
      ...overrides,
    };
    assertNoSecretLikeFixtureValues(fixture);
    return fixture;
  },
};

export type TeamMetaFixtureOptions = Partial<Omit<TeamMetaFile, 'version'>>;

export const teamMetaFixture = {
  basic(options: TeamMetaFixtureOptions = {}): TeamMetaFile {
    const fixture: TeamMetaFile = {
      version: 1,
      displayName: HARNESS_DEFAULT_TEAM_NAME,
      description: 'Harness fixture team',
      color: 'blue',
      cwd: HARNESS_INERT_PROJECT_PATH,
      providerId: 'codex',
      providerBackendId: HARNESS_INERT_PROVIDER_BACKEND_ID,
      model: HARNESS_INERT_MODEL,
      createdAt: Date.parse(HARNESS_DEFAULT_NOW_ISO),
      ...options,
    };
    assertNoSecretLikeFixtureValues(fixture);
    return fixture;
  },
};

export function toMetaMembers(members: TeamCreateRequest['members']): TeamMember[] {
  return members.map(
    (memberValue) =>
      ({
        name: memberValue.name,
        role: memberValue.role,
        workflow: memberValue.workflow,
        isolation: memberValue.isolation,
        cwd: memberValue.cwd,
        providerId: memberValue.providerId,
        model: memberValue.model,
        effort: memberValue.effort,
        mcpPolicy: memberValue.mcpPolicy,
        agentType: 'teammate',
      }) satisfies TeamMember
  );
}

export interface SecretLikeFixtureFinding {
  path: string;
  reason: string;
  patternName?: string;
  stringLength?: number;
  redactedValue?: '<redacted>';
}

const SECRET_LIKE_KEY_PATTERN = new RegExp(
  [
    'api[_-]?key',
    'apiKey',
    'auth[_-]?token',
    'authToken',
    'oauth[_-]?token',
    'oauthToken',
    'secret',
    'password',
    'passwd',
    'private[_-]?key',
    'privateKey',
  ].join('|'),
  'i'
);
const SECRET_LIKE_VALUE_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._-]{10,}\b/i },
  { name: 'openai-api-key', pattern: /\bsk-(?:live|test|proj)?[A-Za-z0-9_-]{10,}\b/i },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{10,}\b/i },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i },
  { name: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{12,}\b/ },
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const SAFE_FIXTURE_PATH_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

function findSecretLikeValuePattern(
  value: string
): (typeof SECRET_LIKE_VALUE_PATTERNS)[number] | undefined {
  return SECRET_LIKE_VALUE_PATTERNS.find(({ pattern }) => pattern.test(value));
}

function findSecretLikeKeyPattern(key: string): { name: string } | undefined {
  if (SECRET_LIKE_KEY_PATTERN.test(key)) {
    return { name: 'secret-like-key' };
  }
  const matchedValuePattern = findSecretLikeValuePattern(key);
  if (matchedValuePattern) {
    return { name: `secret-like-${matchedValuePattern.name}` };
  }
  return undefined;
}

function formatObjectKeyPathSegment(key: string, index: number): string {
  if (findSecretLikeKeyPattern(key)) {
    return `[key#${index}:redacted]`;
  }
  if (SAFE_FIXTURE_PATH_KEY_PATTERN.test(key)) {
    return `[key#${index}:safe]`;
  }
  return `[key#${index}:sanitized]`;
}

function scanFixtureValue(
  value: unknown,
  path: string,
  findings: SecretLikeFixtureFinding[]
): void {
  if (typeof value === 'string') {
    const matchedPattern = findSecretLikeValuePattern(value);
    if (matchedPattern) {
      findings.push({
        path,
        reason: `value matched secret-like pattern ${matchedPattern.name}`,
        patternName: matchedPattern.name,
        stringLength: value.length,
        redactedValue: '<redacted>',
      });
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => scanFixtureValue(item, `${path}[${index}]`, findings));
    return;
  }

  for (const [index, [key, child]] of Object.entries(value).entries()) {
    const childPath = `${path}${formatObjectKeyPathSegment(key, index)}`;
    const matchedKeyPattern = findSecretLikeKeyPattern(key);
    if (matchedKeyPattern) {
      findings.push({
        path: childPath,
        reason: 'key matched secret-like pattern',
        patternName: matchedKeyPattern.name,
      });
    }
    scanFixtureValue(child, childPath, findings);
  }
}

export function collectSecretLikeFixtureValues(value: unknown): SecretLikeFixtureFinding[] {
  const findings: SecretLikeFixtureFinding[] = [];
  scanFixtureValue(value, '$', findings);
  return findings;
}

export function assertNoSecretLikeFixtureValues(value: unknown): void {
  const findings = collectSecretLikeFixtureValues(value);
  if (findings.length === 0) {
    return;
  }

  const details = findings
    .map((finding) =>
      finding.redactedValue
        ? `${finding.path}: ${finding.reason} ` +
          `(length=${finding.stringLength}, value=${finding.redactedValue})`
        : `${finding.path}: ${finding.reason}`
    )
    .join('\n');
  throw new Error(`Secret-like fixture values are not allowed:\n${details}`);
}
