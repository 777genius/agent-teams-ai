declare const hostedIdBrand: unique symbol;
export type ActorId = string & { readonly [hostedIdBrand]: 'ActorId' };
export type SessionId = string & { readonly [hostedIdBrand]: 'SessionId' };
export type DeploymentId = string & { readonly [hostedIdBrand]: 'DeploymentId' };
export type BootId = string & { readonly [hostedIdBrand]: 'BootId' };
export type RequestId = string & { readonly [hostedIdBrand]: 'RequestId' };
export type TeamId = string & { readonly [hostedIdBrand]: 'TeamId' };
export type WorkspaceId = string & { readonly [hostedIdBrand]: 'WorkspaceId' };
export type RunId = string & { readonly [hostedIdBrand]: 'RunId' };
export type MemberId = string & { readonly [hostedIdBrand]: 'MemberId' };
export type LegacyMemberKey = string & { readonly [hostedIdBrand]: 'LegacyMemberKey' };

const MAX_PHASE_ONE_ID_LENGTH = 128;
const CANONICAL_ID_PAYLOAD_LENGTH = 32;
const CANONICAL_ID_PAYLOAD_PATTERN = /^[0-9a-f]{32}$/;
const LEGACY_MEMBER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED_MEMBER_FILE_STEMS = new Set([
  'aux',
  'con',
  'nul',
  'prn',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

const PHASE_ONE_ID_PATTERNS = new Map<string, RegExp>();
function parsePhaseOneId<T extends string>(value: unknown, prefix: string): T {
  let pattern = PHASE_ONE_ID_PATTERNS.get(prefix);
  if (!pattern) {
    pattern = new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9._-]*$`);
    PHASE_ONE_ID_PATTERNS.set(prefix, pattern);
  }
  if (typeof value !== 'string' || value.length > MAX_PHASE_ONE_ID_LENGTH || !pattern.test(value)) {
    throw new TypeError('hosted-contract-identifier-invalid');
  }
  return value as T;
}

function parseCanonicalId<T extends string>(
  value: unknown,
  prefix: 'team' | 'workspace' | 'run' | 'member'
): T {
  const separatorIndex = prefix.length;
  const expectedLength = separatorIndex + 1 + CANONICAL_ID_PAYLOAD_LENGTH;
  if (
    typeof value !== 'string' ||
    value.length !== expectedLength ||
    !value.startsWith(`${prefix}_`) ||
    !CANONICAL_ID_PAYLOAD_PATTERN.test(value.slice(separatorIndex + 1))
  ) {
    throw new TypeError('hosted-contract-canonical-identifier-invalid');
  }
  return value as T;
}

export const parseActorId = (value: unknown): ActorId => parsePhaseOneId(value, 'actor');
export const parseSessionId = (value: unknown): SessionId => parsePhaseOneId(value, 'session');
export const parseDeploymentId = (value: unknown): DeploymentId =>
  parsePhaseOneId(value, 'deployment');
export const parseBootId = (value: unknown): BootId => parsePhaseOneId(value, 'boot');
export const parseRequestId = (value: unknown): RequestId => parsePhaseOneId(value, 'request');

export const parseTeamId = (value: unknown): TeamId => parseCanonicalId(value, 'team');
export const parseWorkspaceId = (value: unknown): WorkspaceId =>
  parseCanonicalId(value, 'workspace');
export const parseRunId = (value: unknown): RunId => parseCanonicalId(value, 'run');
export const parseMemberId = (value: unknown): MemberId => parseCanonicalId(value, 'member');
export const parseLegacyMemberKey = (value: unknown): LegacyMemberKey => {
  if (
    typeof value !== 'string' ||
    !LEGACY_MEMBER_KEY_PATTERN.test(value) ||
    value.endsWith('.') ||
    WINDOWS_RESERVED_MEMBER_FILE_STEMS.has(value.toLowerCase().split('.')[0] ?? '')
  ) {
    throw new TypeError('hosted-contract-legacy-member-key-invalid');
  }
  return value as LegacyMemberKey;
};

/**
 * Phase 1 compatibility values are synthetic fixture identities, never canonical IDs or legacy team
 * names. New production contracts must use parseTeamId.
 */
export const parseSyntheticTeamId = (value: unknown): TeamId => parsePhaseOneId(value, 'team');
