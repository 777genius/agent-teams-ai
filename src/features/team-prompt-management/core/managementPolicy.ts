import { parseNumericSuffixName, validateTeamMemberNameFormat } from '@shared/utils/teamMemberName';

import type { TeamManagementTarget, TeamManagementUpdate } from '../contracts';

export class TeamManagementError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
    readonly outcome?: { state: 'partial' | 'uncertain'; configurationRevision?: string }
  ) {
    super(`${code}: ${message}`);
    this.name = 'TeamManagementError';
  }
}
function invalid(message: string): never {
  throw new TeamManagementError('INVALID_MANAGEMENT_REQUEST', message, 400);
}
function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)))
    invalid(`${label} contains unsupported fields`);
  return result;
}
function string(value: unknown, label: string, required = false): string {
  if (typeof value !== 'string' || value.length > 200_000)
    invalid(`${label} must be a bounded string`);
  const result = value.trim();
  if (required && !result) invalid(`${label} cannot be empty`);
  return result;
}
export function parseTeamManagementRequest(
  teamName: unknown,
  body: unknown,
  update: true
): TeamManagementUpdate;
export function parseTeamManagementRequest(
  teamName: unknown,
  body: unknown,
  update: false
): TeamManagementTarget;
export function parseTeamManagementRequest(
  teamName: unknown,
  body: unknown,
  update: boolean
): TeamManagementUpdate {
  if (typeof teamName !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(teamName))
    invalid('Exact teamName is required');
  const value = object(
    body,
    [
      'expectedContext',
      'expectedRevision',
      ...(update ? ['metadata', 'leadInstructions', 'members'] : []),
    ],
    'request'
  );
  const context = object(
    value.expectedContext,
    ['appInstanceId', 'dataRootFingerprint', 'connectionGeneration'],
    'expectedContext'
  );
  const generation = context.connectionGeneration;
  if (!Number.isSafeInteger(generation) || (generation as number) < 1)
    invalid('Invalid connectionGeneration');
  const result: TeamManagementUpdate = {
    teamName,
    expectedContext: {
      appInstanceId: string(context.appInstanceId, 'appInstanceId', true),
      dataRootFingerprint: string(context.dataRootFingerprint, 'dataRootFingerprint', true),
      connectionGeneration: generation as number,
    },
    expectedRevision: string(value.expectedRevision, 'expectedRevision', true),
  };
  if (!update) return result;
  const groups = ['metadata', 'leadInstructions', 'members'].filter((key) => key in value);
  if (groups.length !== 1) invalid('Specify exactly one of metadata, leadInstructions or members');
  if ('metadata' in value) {
    const metadata = object(value.metadata, ['displayName', 'description', 'color'], 'metadata');
    if (!Object.keys(metadata).length) invalid('metadata must contain at least one field');
    result.metadata = {};
    for (const key of ['displayName', 'description', 'color'] as const) {
      if (key in metadata) result.metadata[key] = string(metadata[key], key, key === 'displayName');
    }
  }
  if ('leadInstructions' in value)
    result.leadInstructions = string(value.leadInstructions, 'leadInstructions');
  if ('members' in value) {
    if (!Array.isArray(value.members) || value.members.length > 100)
      invalid('members must be an array of at most 100 active teammates');
    const names = new Set<string>();
    result.members = value.members.map((entry) => {
      const member = object(entry, ['name', 'role', 'workflow'], 'member');
      const name = string(member.name, 'member.name', true);
      const suffix = parseNumericSuffixName(name);
      if (
        validateTeamMemberNameFormat(name) ||
        ['user', 'system', 'team-lead'].includes(name.toLowerCase()) ||
        (suffix && suffix.suffix >= 2)
      )
        invalid(`Invalid teammate name: ${name}`);
      if (names.has(name.toLowerCase())) invalid(`Duplicate teammate name: ${name}`);
      names.add(name.toLowerCase());
      return {
        name,
        ...(member.role !== undefined ? { role: string(member.role, 'role') } : {}),
        ...(member.workflow !== undefined ? { workflow: string(member.workflow, 'workflow') } : {}),
      };
    });
  }
  return result;
}
