import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parseTeamIdentityRecord } from '@features/internal-storage/contracts';
import { buildHostedPromotionMembersMeta } from '@main/composition/hosted/hostedPromotionMembersMeta';
import { openHostedTaskBoardDirectory } from '@main/composition/hosted/hostedTaskBoardDescriptorFs';
import {
  HostedTaskBoardRosterAuthority,
  hostedTaskBoardRosterMemberId,
} from '@main/composition/hosted/hostedTaskBoardRosterAuthority';
import { parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

// The same bytes live in agent_teams_orchestrator docs/; both repositories pin this digest.
const GOLDEN_SHA256 = '643eae7aea140911b732b048bb0d7db239ef689c57aa04fca39e7fd0e90d738c';
const GOLDEN_PATH = resolve('docs/hosted-roster-identity-golden.json');
const FORMAT = 'agent-teams.hosted-roster-identity-golden/v1';

const TEAM_ID = parseTeamId(`team_${'d2'.repeat(16)}`);
const LEGACY_KEY = 'golden-roster-team';
const EXPLICIT_MEMBER_ID = `member_${'e3'.repeat(16)}`;
const JOINED_AT = 1_790_000_000_000;

/** Raw member names that only the formula sees, including shapes desktop rosters can hold. */
const FORMULA_NAMES = [
  'alice',
  'Alice',
  'иван',
  'dev.ops_1',
  `alice\u0000${JOINED_AT}`,
  `alice@${LEGACY_KEY}`,
];

/**
 * One record per identity rule, in the precedence Product and the Owner share: an explicit
 * memberId, then name plus joinedAt, then agentId, then the bare name. Removed members and the
 * reserved `user` name are not active owners.
 */
const MEMBERS_META = {
  version: 1,
  members: [
    { name: 'team-lead', agentId: `team-lead@${LEGACY_KEY}`, agentType: 'team-lead' },
    { name: 'alice', memberId: EXPLICIT_MEMBER_ID, agentId: `alice@${LEGACY_KEY}` },
    { name: 'bob', joinedAt: JOINED_AT, agentId: `bob@${LEGACY_KEY}` },
    { name: 'carol' },
    { name: 'dave', agentId: `dave@${LEGACY_KEY}`, removedAt: JOINED_AT + 1 },
    { name: 'user' },
  ],
};
const EXPECTED_IMMUTABLE_IDENTITIES: Readonly<Record<string, string | null>> = {
  'team-lead': `team-lead@${LEGACY_KEY}`,
  alice: null,
  bob: `bob\u0000${JOINED_AT}`,
  carol: 'carol',
};

const FROZEN_DRAFT_JSON = JSON.stringify({
  configuration: {
    schemaVersion: 1,
    toolApprovalMode: 'auto',
    lanes: [
      {
        kind: 'opencode',
        provider: 'opencode',
        selectedModel: 'openrouter/minimax-m2.5',
        effort: 'medium',
        members: [
          { name: 'team-lead', prompt: 'Lead the team.' },
          { name: 'alice', prompt: 'Write code.' },
          { name: 'dev.ops_1', prompt: 'Run the build.' },
        ],
      },
    ],
  },
});

function activeMembers() {
  return Object.entries(EXPECTED_IMMUTABLE_IDENTITIES).map(([name, immutableIdentity]) => ({
    name,
    memberId:
      immutableIdentity === null
        ? EXPLICIT_MEMBER_ID
        : hostedTaskBoardRosterMemberId(TEAM_ID, immutableIdentity),
  }));
}

function generate() {
  return {
    format: FORMAT,
    source: 'agent-teams-ai test/main/composition/hosted/hostedRosterIdentity.golden.test.ts',
    teamId: TEAM_ID,
    formula: FORMULA_NAMES.map((rawMemberName) => ({
      rawMemberName,
      memberId: hostedTaskBoardRosterMemberId(TEAM_ID, rawMemberName),
    })),
    roster: {
      membersMetaJson: `${JSON.stringify(MEMBERS_META, null, 2)}\n`,
      activeMembers: activeMembers(),
      activeRecipients: ['alice', 'bob', 'carol'],
      inactiveNames: ['team-lead', 'dave', 'user'],
    },
    promotion: {
      legacyKey: LEGACY_KEY,
      frozenDraftJson: FROZEN_DRAFT_JSON,
      membersMetaJson: buildHostedPromotionMembersMeta({
        teamId: TEAM_ID,
        legacyKey: LEGACY_KEY,
        frozenDraftJson: FROZEN_DRAFT_JSON,
      }),
    },
  };
}

describe('hosted roster identity cross-repository golden', () => {
  it('is exactly the member identity Product derives and publishes', () => {
    const serialized = `${JSON.stringify(generate(), null, 2)}\n`;
    if (process.env.HOSTED_ROSTER_IDENTITY_GOLDEN_WRITE === '1') {
      writeFileSync(GOLDEN_PATH, serialized);
    }
    const raw = readFileSync(GOLDEN_PATH);
    expect(raw.toString('utf8')).toBe(serialized);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(GOLDEN_SHA256);
  });

  // The task-board roster reader pins descriptors through /proc/self/fd.
  it.runIf(process.platform === 'linux')(
    'matches what the task-board roster authority reads from members.meta.json',
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-roster-golden-')));
      try {
        const teamRoot = join(root, LEGACY_KEY);
        await mkdir(teamRoot);
        const identityFile = `${JSON.stringify(
          { schemaVersion: 1, teamId: TEAM_ID, createdAt: '2026-09-25T00:00:00.000Z' },
          null,
          2
        )}\n`;
        await writeFile(join(teamRoot, 'team.identity.json'), identityFile);
        await writeFile(join(teamRoot, 'members.meta.json'), generate().roster.membersMetaJson);
        const identity = parseTeamIdentityRecord({
          teamId: TEAM_ID,
          state: 'active',
          legacyKey: LEGACY_KEY,
          directoryFingerprint: 'cd'.repeat(32),
          workspaceBinding: {
            workspaceId: parseWorkspaceId(`workspace_${'f4'.repeat(16)}`),
            generation: 1,
          },
          adoptionIntentId: `adoption_${'a5'.repeat(16)}`,
          identityChecksum: createHash('sha256').update(identityFile, 'utf8').digest('hex'),
          createdAt: '2026-09-25T00:00:00.000Z',
          activatedAt: '2026-09-25T00:00:01.000Z',
          tombstonedAt: null,
        });
        const directory = await openHostedTaskBoardDirectory(teamRoot, null, null);
        try {
          const snapshot = await new HostedTaskBoardRosterAuthority().readActiveRoster(
            directory,
            identity
          );
          expect(
            [...snapshot.ownerAliases].filter(([alias]) => !alias.startsWith('member_'))
          ).toEqual(activeMembers().map(({ name, memberId }) => [name, memberId]));
        } finally {
          await directory.handle.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});
