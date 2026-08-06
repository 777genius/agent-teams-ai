import { createHash } from 'node:crypto';

import { type TeamIdentityRecord } from '@features/internal-storage/contracts';
import {
  type MemberId,
  parseLegacyMemberKey,
  parseMemberId,
  type TeamId,
} from '@shared/contracts/hosted';

import {
  type HostedTaskBoardDirectoryDescriptor,
  type HostedTaskBoardFileSnapshot,
  readHostedTaskBoardFile,
} from './hostedTaskBoardDescriptorFs';

const MAX_ROSTER_FILE_BYTES = 256 * 1024;
const TEAM_IDENTITY_FILE = 'team.identity.json';
const LEAD_AGENT_TYPES = new Set(['lead', 'orchestrator', 'team-lead']);

type JsonRecord = Record<string, unknown>;
type MemberState = 'active' | 'removed';

export interface HostedTaskBoardRosterSnapshot {
  readonly activeMembers: ReadonlyMap<MemberId, string>;
  readonly files: readonly HostedTaskBoardFileSnapshot[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function hostedTaskBoardRosterMemberId(teamId: TeamId, rawMemberName: string): MemberId {
  return parseMemberId(
    `member_${digest({
      domain: 'hosted-task-board-member/v1',
      teamId,
      rawMemberName,
    }).slice(0, 32)}`
  );
}

/** Validates the active internal identity file through an already-open team descriptor. */
export function assertHostedTaskBoardTeamIdentity(
  serialized: string,
  expected: TeamIdentityRecord
): void {
  const value: unknown = JSON.parse(serialized);
  if (!isRecord(value)) throw new TypeError('hosted-task-board-roster-identity-invalid');
  const hasOriginDeploymentId = value.originDeploymentId !== undefined;
  const expectedKeys = hasOriginDeploymentId
    ? ['createdAt', 'originDeploymentId', 'schemaVersion', 'teamId']
    : ['createdAt', 'schemaVersion', 'teamId'];
  const keys = Reflect.ownKeys(value).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    value.schemaVersion !== 1 ||
    value.teamId !== expected.teamId ||
    !canonicalTimestamp(value.createdAt) ||
    value.createdAt !== expected.createdAt ||
    (hasOriginDeploymentId && typeof value.originDeploymentId !== 'string') ||
    expected.identityChecksum === null ||
    digestText(serialized) !== expected.identityChecksum
  ) {
    throw new TypeError('hosted-task-board-roster-identity-invalid');
  }
  const canonical = {
    schemaVersion: 1,
    teamId: expected.teamId,
    createdAt: expected.createdAt,
    ...(hasOriginDeploymentId ? { originDeploymentId: value.originDeploymentId } : {}),
  };
  if (`${JSON.stringify(canonical, null, 2)}\n` !== serialized) {
    throw new TypeError('hosted-task-board-roster-identity-invalid');
  }
}

function nonRosterMember(record: JsonRecord): boolean {
  const name = typeof record.name === 'string' ? record.name.toLowerCase() : '';
  const agentType = typeof record.agentType === 'string' ? record.agentType : '';
  return name === 'team-lead' || name === 'user' || LEAD_AGENT_TYPES.has(agentType);
}

function parseMember(
  record: JsonRecord
): { readonly name: string; readonly state: MemberState } | null {
  if (nonRosterMember(record)) return null;
  const name = parseLegacyMemberKey(record.name);
  if (record.removedAt !== undefined && !Number.isFinite(record.removedAt)) {
    throw new TypeError('hosted-task-board-roster-member-invalid');
  }
  return Object.freeze({ name, state: record.removedAt === undefined ? 'active' : 'removed' });
}

function parseConfigMembers(
  value: unknown
): readonly { readonly name: string; readonly state: MemberState }[] {
  if (value === undefined) return [];
  if (!isRecord(value)) throw new TypeError('hosted-task-board-roster-config-invalid');
  if (value.members === undefined) return [];
  if (!Array.isArray(value.members)) throw new TypeError('hosted-task-board-roster-config-invalid');
  return parseMembers(value.members);
}

function parseMembersMetaMembers(
  value: unknown
): readonly { readonly name: string; readonly state: MemberState }[] {
  if (value === undefined) return [];
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.members)) {
    throw new TypeError('hosted-task-board-roster-meta-invalid');
  }
  return parseMembers(value.members);
}

function parseMembers(
  values: readonly unknown[]
): readonly { readonly name: string; readonly state: MemberState }[] {
  if (values.length > 512) throw new TypeError('hosted-task-board-roster-member-budget');
  const parsed: { name: string; state: MemberState }[] = [];
  const names = new Set<string>();
  for (const value of values) {
    if (!isRecord(value)) throw new TypeError('hosted-task-board-roster-member-invalid');
    const member = parseMember(value);
    if (member === null) continue;
    if (names.has(member.name)) throw new TypeError('hosted-task-board-roster-member-duplicate');
    names.add(member.name);
    parsed.push(member);
  }
  return Object.freeze(parsed);
}

export class HostedTaskBoardRosterAuthority {
  async readActiveRoster(
    teamDirectory: HostedTaskBoardDirectoryDescriptor,
    identity: TeamIdentityRecord,
    assertStillActive?: () => void
  ): Promise<HostedTaskBoardRosterSnapshot> {
    const identityFile = await readHostedTaskBoardFile(
      teamDirectory,
      TEAM_IDENTITY_FILE,
      4 * 1024,
      {
        assertStillActive,
      }
    );
    if (!identityFile.exists) throw new TypeError('hosted-task-board-roster-identity-missing');
    assertHostedTaskBoardTeamIdentity(identityFile.text, identity);
    const [config, membersMeta] = await Promise.all([
      readHostedTaskBoardFile(teamDirectory, 'config.json', MAX_ROSTER_FILE_BYTES, {
        optional: true,
        assertStillActive,
      }),
      readHostedTaskBoardFile(teamDirectory, 'members.meta.json', MAX_ROSTER_FILE_BYTES, {
        optional: true,
        assertStillActive,
      }),
    ]);
    const configValue = config.exists ? JSON.parse(config.text) : undefined;
    const membersMetaValue = membersMeta.exists ? JSON.parse(membersMeta.text) : undefined;
    const configMembers = parseConfigMembers(configValue);
    const membersMetaMembers = parseMembersMetaMembers(membersMetaValue);
    // A present members.meta file is the durable current roster, including its empty and
    // tombstone-only states. Falling back to config members in that case would resurrect removed
    // owners that are still present only in legacy config.json.
    const currentMembers = membersMeta.exists ? membersMetaMembers : configMembers;
    const memberStates = new Map<string, MemberState>();
    for (const member of currentMembers) {
      memberStates.set(member.name, member.state);
    }
    const activeMembers = new Map<MemberId, string>();
    for (const [name, state] of memberStates) {
      if (state !== 'active') continue;
      const memberId = hostedTaskBoardRosterMemberId(identity.teamId, name);
      if (activeMembers.has(memberId)) {
        throw new TypeError('hosted-task-board-roster-member-id-collision');
      }
      activeMembers.set(memberId, name);
    }
    return Object.freeze({
      activeMembers,
      files: Object.freeze([identityFile, config, membersMeta]),
    });
  }

  resolveActiveMember(snapshot: HostedTaskBoardRosterSnapshot, ownerId: MemberId): string | null {
    return snapshot.activeMembers.get(ownerId) ?? null;
  }
}
