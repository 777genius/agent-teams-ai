import { createHash } from 'node:crypto';

import { type TeamIdentityRecord } from '@features/internal-storage/contracts';
import { type MemberId, parseMemberId, type TeamId } from '@shared/contracts/hosted';
import * as agentTeamsControllerModule from 'agent-teams-controller';

import {
  type HostedTaskBoardDirectoryDescriptor,
  type HostedTaskBoardFileSnapshot,
  readHostedTaskBoardFile,
} from './hostedTaskBoardDescriptorFs';

const { hostedRosterMemberIdForIdentity } = agentTeamsControllerModule.hostedBoardIdentity;
const { hostedActiveRosterMembers } = agentTeamsControllerModule.hostedBoardProjection;

const MAX_ROSTER_FILE_BYTES = 256 * 1024;
const TEAM_IDENTITY_FILE = 'team.identity.json';
type JsonRecord = Record<string, unknown>;

export interface HostedTaskBoardRosterSnapshot {
  /**
   * Task documents persist this value directly. Keeping it equal to the immutable member ID means
   * a same-name roster replacement cannot inherit a prior member's task ownership.
   */
  readonly activeMembers: ReadonlyMap<MemberId, string>;
  /**
   * Resolves a task file's raw `owner` to an active member: its member ID, or its name as the
   * agent task tools and the desktop app write it. Removed members never resolve.
   */
  readonly ownerAliases: ReadonlyMap<string, MemberId>;
  readonly files: readonly HostedTaskBoardFileSnapshot[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  return parseMemberId(hostedRosterMemberIdForIdentity(teamId, rawMemberName));
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
    // members.meta.json, when present, is the durable current roster, including its empty and
    // tombstone-only states; the hosted task command resolves owners from the same rule.
    const members = hostedActiveRosterMembers(identity.teamId, {
      config: config.exists ? config.text : null,
      meta: membersMeta.exists ? membersMeta.text : null,
    });
    const activeMembers = new Map<MemberId, string>();
    const names = new Map<string, MemberId>();
    for (const [rawMemberId, name] of members) {
      const memberId = parseMemberId(rawMemberId);
      activeMembers.set(memberId, memberId);
      names.set(name, memberId);
    }
    // A member ID always wins over a same-spelled name of another member.
    const ownerAliases = new Map<string, MemberId>(names);
    for (const memberId of activeMembers.keys()) ownerAliases.set(memberId, memberId);
    return Object.freeze({
      activeMembers,
      ownerAliases,
      files: Object.freeze([identityFile, config, membersMeta]),
    });
  }

  resolveActiveMember(snapshot: HostedTaskBoardRosterSnapshot, ownerId: MemberId): string | null {
    return snapshot.activeMembers.get(ownerId) ?? null;
  }
}
