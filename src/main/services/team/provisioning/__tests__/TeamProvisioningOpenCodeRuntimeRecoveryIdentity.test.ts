import { describe, expect, it, vi } from 'vitest';

import {
  createOpenCodeRuntimeRecoveryIdentityHelpers,
  resolveOpenCodeMemberDeliveryIdentityFromDirectory,
  resolveOpenCodeMembersForRuntimeLaneFromDirectory,
} from '../TeamProvisioningOpenCodeRuntimeRecoveryIdentity';

import type {
  OpenCodeMemberDirectory,
  OpenCodeMemberIdentityResolution,
} from '../../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type { OpenCodeRuntimeLaneIndex } from '../../opencode/store/OpenCodeRuntimeManifestEvidenceReader';

function createLaneIndex(lanes: OpenCodeRuntimeLaneIndex['lanes']): OpenCodeRuntimeLaneIndex {
  return {
    version: 1,
    updatedAt: '2026-07-02T00:00:00.000Z',
    lanes,
  };
}

function createDirectory(input: Partial<OpenCodeMemberDirectory> = {}): OpenCodeMemberDirectory {
  return {
    config: {
      name: 'runtime-recovery-team',
      projectPath: '/fake/project',
      members: [],
    },
    teamMeta: null,
    metaMembers: [],
    ...input,
  };
}

function createHelpers(input: {
  currentRunId?: string | null;
  directory?: OpenCodeMemberDirectory;
  identityResolver?: (
    teamName: string,
    memberName: string,
    directory: OpenCodeMemberDirectory
  ) => OpenCodeMemberIdentityResolution;
  readLaneIndex?: () => Promise<OpenCodeRuntimeLaneIndex>;
  readManifestEvidence?: () => Promise<{ activeRunId?: string | null }>;
}) {
  return createOpenCodeRuntimeRecoveryIdentityHelpers({
    getTeamsBasePath: () => '/fake/teams',
    getCurrentOpenCodeRuntimeRunId: vi.fn(() => input.currentRunId ?? null),
    readOpenCodeMemberDirectory: vi.fn(async () => input.directory ?? createDirectory()),
    resolveOpenCodeMemberIdentityFromDirectory:
      input.identityResolver ??
      vi.fn((_, memberName) => ({
        ok: true,
        canonicalMemberName: memberName.trim(),
        laneId: 'primary',
        laneIdentity: {
          laneId: 'primary',
          laneKind: 'primary',
        },
      })),
    readOpenCodeRuntimeLaneIndex: input.readLaneIndex
      ? vi.fn(async () => input.readLaneIndex?.() ?? createLaneIndex({}))
      : undefined,
    readOpenCodeRuntimeManifestEvidence: input.readManifestEvidence
      ? vi.fn(async () => input.readManifestEvidence?.() ?? {})
      : undefined,
  });
}

describe('TeamProvisioningOpenCodeRuntimeRecoveryIdentity', () => {
  it('projects directory identity resolution to the delivery identity contract', () => {
    const directory = createDirectory();

    expect(
      resolveOpenCodeMemberDeliveryIdentityFromDirectory({
        teamName: 'team-a',
        memberName: 'bob',
        directory,
        resolveOpenCodeMemberIdentityFromDirectory: vi.fn(() => ({
          ok: true,
          canonicalMemberName: 'Bob',
          laneId: 'secondary:opencode:bob',
          laneIdentity: {
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
          },
          memberRuntimeCwd: '/fake/member',
        })),
      })
    ).toEqual({
      ok: true,
      canonicalMemberName: 'Bob',
      laneId: 'secondary:opencode:bob',
    });
  });

  it('deduplicates canonical members resolved from config and meta sources for a lane', () => {
    const directory = createDirectory({
      config: {
        name: 'runtime-recovery-team',
        projectPath: '/fake/project',
        members: [
          { name: ' bob ', role: 'Builder', providerId: 'opencode' },
          { name: 'Robert', role: 'Builder', providerId: 'opencode' },
        ],
      },
      metaMembers: [
        { name: 'bob', role: 'Builder', providerId: 'opencode' },
        { name: 'alice', role: 'Reviewer', providerId: 'opencode' },
      ],
    });

    expect(
      resolveOpenCodeMembersForRuntimeLaneFromDirectory({
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        directory,
        resolveOpenCodeMemberIdentityFromDirectory: vi.fn((_, memberName) => ({
          ok: true,
          canonicalMemberName: ['bob', 'robert'].includes(memberName.trim().toLowerCase())
            ? 'Bob'
            : memberName.trim(),
          laneId:
            memberName.trim().toLowerCase() === 'alice' ? 'primary' : 'secondary:opencode:bob',
          laneIdentity: {
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
          },
        })),
      })
    ).toEqual(['Bob']);
  });

  it('uses case-insensitive secondary lane fallback only when the suffix has content', () => {
    const directory = createDirectory();
    const resolveOpenCodeMemberIdentityFromDirectory = vi.fn(() => ({
      ok: false as const,
      reason: 'opencode_recipient_unavailable' as const,
    }));

    expect(
      resolveOpenCodeMembersForRuntimeLaneFromDirectory({
        teamName: 'team-a',
        laneId: 'SECONDARY:OPENCODE: Bob ',
        directory,
        resolveOpenCodeMemberIdentityFromDirectory,
      })
    ).toEqual(['Bob']);
    expect(
      resolveOpenCodeMembersForRuntimeLaneFromDirectory({
        teamName: 'team-a',
        laneId: 'secondary:opencode:   ',
        directory,
        resolveOpenCodeMemberIdentityFromDirectory,
      })
    ).toEqual([]);
  });

  it('prefers the in-memory runtime run id before reading durable lane state', async () => {
    const readLaneIndex = vi.fn(async () => createLaneIndex({}));
    const helpers = createOpenCodeRuntimeRecoveryIdentityHelpers({
      getTeamsBasePath: () => '/fake/teams',
      getCurrentOpenCodeRuntimeRunId: vi.fn(() => 'run-live'),
      readOpenCodeMemberDirectory: vi.fn(async () => createDirectory()),
      resolveOpenCodeMemberIdentityFromDirectory: vi.fn(),
      readOpenCodeRuntimeLaneIndex: readLaneIndex,
      readOpenCodeRuntimeManifestEvidence: vi.fn(),
    });

    await expect(
      helpers.resolveCurrentOpenCodeRuntimeRunId('team-a', 'secondary:opencode:bob')
    ).resolves.toBe('run-live');
    expect(readLaneIndex).not.toHaveBeenCalled();
  });

  it('reads durable active-run evidence only for active lane index entries', async () => {
    const readManifestEvidence = vi.fn(async () => ({ activeRunId: ' durable-run ' }));
    const helpers = createHelpers({
      readLaneIndex: async () =>
        createLaneIndex({
          primary: {
            laneId: 'primary',
            state: 'active',
            updatedAt: '2026-07-02T00:00:00.000Z',
          },
        }),
      readManifestEvidence,
    });

    await expect(helpers.resolveCurrentOpenCodeRuntimeRunId('team-a', 'primary')).resolves.toBe(
      'durable-run'
    );
    expect(readManifestEvidence).toHaveBeenCalledOnce();
  });

  it('does not read durable run evidence when the lane is not active', async () => {
    const readManifestEvidence = vi.fn(async () => ({ activeRunId: 'run-stopped' }));
    const helpers = createHelpers({
      readLaneIndex: async () =>
        createLaneIndex({
          primary: {
            laneId: 'primary',
            state: 'stopped',
            updatedAt: '2026-07-02T00:00:00.000Z',
          },
        }),
      readManifestEvidence,
    });

    await expect(helpers.resolveCurrentOpenCodeRuntimeRunId('team-a', 'primary')).resolves.toBe(
      null
    );
    expect(readManifestEvidence).not.toHaveBeenCalled();
  });

  it('resolves member delivery identity to the canonical member and lane only', async () => {
    const directory = createDirectory();
    const helpers = createHelpers({
      directory,
      identityResolver: vi.fn(() => ({
        ok: true,
        canonicalMemberName: 'Bob',
        laneId: 'secondary:opencode:bob',
        laneIdentity: {
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
        },
        memberRuntimeCwd: '/fake/member',
      })),
    });

    await expect(helpers.resolveOpenCodeMemberDeliveryIdentity('team-a', 'bob')).resolves.toEqual({
      ok: true,
      canonicalMemberName: 'Bob',
      laneId: 'secondary:opencode:bob',
    });
  });

  it('resolves unique configured and meta members for a runtime lane', async () => {
    const helpers = createHelpers({
      directory: createDirectory({
        config: {
          name: 'runtime-recovery-team',
          projectPath: '/fake/project',
          members: [
            { name: ' bob ', role: 'Builder', providerId: 'opencode' },
            { name: 'alice', role: 'Reviewer', providerId: 'opencode' },
          ],
        },
        metaMembers: [
          { name: 'bob', role: 'Builder', providerId: 'opencode' },
          { name: 'charlie', role: 'Reviewer', providerId: 'opencode' },
        ],
      }),
      identityResolver: vi.fn((_, memberName) => ({
        ok: true,
        canonicalMemberName: memberName.trim().toUpperCase(),
        laneId: memberName.trim().toLowerCase() === 'alice' ? 'primary' : 'secondary:opencode:bob',
        laneIdentity: {
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
        },
      })),
    });

    await expect(
      helpers.resolveOpenCodeMembersForRuntimeLane('team-a', 'secondary:opencode:bob')
    ).resolves.toEqual(['BOB', 'CHARLIE']);
  });

  it('falls back to the secondary lane id member suffix when no directory member resolves', async () => {
    const helpers = createHelpers({
      identityResolver: vi.fn(() => ({ ok: false, reason: 'opencode_recipient_unavailable' })),
    });

    await expect(
      helpers.resolveOpenCodeMembersForRuntimeLane('team-a', 'secondary:opencode:bob')
    ).resolves.toEqual(['bob']);
  });

  it('treats unreadable lane index state as inactive', async () => {
    const helpers = createHelpers({
      readLaneIndex: async () => {
        throw new Error('unreadable');
      },
    });

    await expect(helpers.isOpenCodeRuntimeLaneIndexActive('team-a', 'primary')).resolves.toBe(
      false
    );
  });
});
