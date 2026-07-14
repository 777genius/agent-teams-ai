import { describe, expect, it } from 'vitest';

import {
  assertConfigRawLeadOnlyForLaunch,
  buildMembersMetaWritePayload,
  collectConfigLaunchBaseNamesFromConfigMembers,
  collectConfigLaunchBaseNamesFromMetaMembers,
  createInboxJsonFileSet,
  mergeInboxMessageLists,
  mergeMembersMetaForLaunch,
  parseInboxMessageListRaw,
  planCliAutoSuffixedConfigMemberCleanup,
  planCliAutoSuffixedMetaMemberCleanup,
  planInboxDuplicateMerge,
  planTeamConfigLaunchNormalization,
} from '../TeamProvisioningConfigLaunchNormalization';

import type { TeamCreateRequest, TeamMember } from '@shared/types';

function memberNames(members: readonly Record<string, unknown>[]): unknown[] {
  return members.map((member) => member.name);
}

describe('team provisioning config launch normalization planning', () => {
  it('accepts lead-only launch configs and rejects teammate configs before launch', () => {
    expect(() =>
      assertConfigRawLeadOnlyForLaunch(
        JSON.stringify({
          leadAgentId: 'lead-123',
          members: [
            { name: 'Lead Alias', agentType: 'general-purpose', agentId: 'lead-123' },
            { name: 'team-lead', agentType: 'general-purpose' },
            { name: 'user' },
          ],
        })
      )
    ).not.toThrow();

    expect(() =>
      assertConfigRawLeadOnlyForLaunch(
        JSON.stringify({
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'Alice', agentType: 'general-purpose' },
          ],
        })
      )
    ).toThrow(
      'Refusing to launch: config.json still contains teammates (e.g. "Alice"), which can trigger CLI auto-suffixes like "Alice-2".'
    );
  });

  it('preserves lead-only launch config parse failure messages', () => {
    expect(() => assertConfigRawLeadOnlyForLaunch(null)).toThrow('config.json unreadable');
    expect(() => assertConfigRawLeadOnlyForLaunch('{not json')).toThrow(
      'config.json could not be parsed'
    );
    expect(() => assertConfigRawLeadOnlyForLaunch('42')).toThrow('config.json has invalid shape');
  });

  it('plans CLI auto-suffixed config member cleanup without dropping intentional suffix names', () => {
    const plan = planCliAutoSuffixedConfigMemberCleanup(
      JSON.stringify({
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'user' },
          { name: 'Alice' },
          { name: 'Alice-2' },
          { name: 'Dev-1' },
          { name: 'Ghost-2' },
        ],
      })
    );

    expect(plan?.removedNames).toEqual(['Alice-2']);
    expect(plan ? memberNames(plan.nextMembers) : []).toEqual([
      'team-lead',
      'user',
      'Alice',
      'Dev-1',
      'Ghost-2',
    ]);
  });

  it('plans CLI auto-suffixed members.meta cleanup and active inbox names', () => {
    const plan = planCliAutoSuffixedMetaMemberCleanup([
      { name: 'team-lead', agentType: 'team-lead' },
      { name: 'user' },
      { name: 'Bob' },
      { name: 'Bob-2' },
      { name: 'Removed', removedAt: 123 },
      { name: 'Removed-2', removedAt: 123 },
    ]);

    expect(plan.removedNames).toEqual(['Bob-2']);
    expect(plan.nextMembers.map((member) => member.name)).toEqual([
      'team-lead',
      'user',
      'Bob',
      'Removed',
      'Removed-2',
    ]);
    expect(Array.from(plan.activeNamesForInboxCleanup)).toEqual(['Bob']);
  });

  it('plans launch config normalization and fallback base-name collection', () => {
    const plan = planTeamConfigLaunchNormalization(
      JSON.stringify({
        leadAgentId: 'lead-123',
        members: [
          { name: 'Lead Alias', agentType: 'general-purpose', agentId: 'lead-123' },
          { name: 'team-lead', agentType: 'general-purpose' },
          { name: 'user', agentType: 'general-purpose' },
          { name: 'Alice', agentType: 'general-purpose' },
          { name: 'Alice-2', agentType: 'general-purpose' },
          { name: 'Dev-1', agentType: 'general-purpose' },
          { name: 'NoType' },
        ],
      })
    );

    expect(plan).not.toBeNull();
    expect(plan ? memberNames(plan.leadMembers) : []).toEqual(['Lead Alias', 'team-lead']);
    expect(
      plan ? Array.from(collectConfigLaunchBaseNamesFromConfigMembers(plan.members)) : []
    ).toEqual(['Lead Alias', 'Alice', 'Dev-1']);
  });

  it('collects launch base names from active members.meta entries', () => {
    const members: TeamMember[] = [
      { name: 'team-lead', agentType: 'team-lead' },
      { name: 'user' },
      { name: 'Reviewer' },
      { name: 'Removed', removedAt: 123 },
    ];

    expect(Array.from(collectConfigLaunchBaseNamesFromMetaMembers(members))).toEqual(['Reviewer']);
  });
});

describe('team provisioning inbox merge planning', () => {
  it('plans canonical inbox duplicate merges from existing JSON filenames', () => {
    const existing = createInboxJsonFileSet([
      '.hidden.json',
      'Alice.json',
      'Alice-2.json',
      'Alice-10.json',
      'Alice-notes.txt',
      'Bob-2.json',
      'Dev.json',
      'Dev-1.json',
    ]);

    expect(planInboxDuplicateMerge('Alice', existing)).toEqual({
      baseName: 'Alice',
      canonicalFile: 'Alice.json',
      duplicateFiles: ['Alice-2.json', 'Alice-10.json'],
    });
    expect(planInboxDuplicateMerge('Dev', existing)).toEqual({
      baseName: 'Dev',
      canonicalFile: 'Dev.json',
      duplicateFiles: ['Dev-1.json'],
    });
    expect(planInboxDuplicateMerge('Bob', existing)).toBeNull();
  });

  it('does not merge hyphenated member inboxes into shorter base names', () => {
    const existing = createInboxJsonFileSet(['Ann.json', 'Ann-2.json', 'Ann-Marie-2.json']);

    expect(planInboxDuplicateMerge('Ann', existing)).toEqual({
      baseName: 'Ann',
      canonicalFile: 'Ann.json',
      duplicateFiles: ['Ann-2.json'],
    });
  });

  it('merges inbox messages with messageId dedupe and descending timestamp order', () => {
    const canonical = parseInboxMessageListRaw(
      JSON.stringify([
        { messageId: 'same', timestamp: '2026-01-01T00:00:00.000Z', text: 'old' },
        { messageId: 'keep', timestamp: '2026-01-01T00:00:02.000Z', text: 'keep' },
        { timestamp: '2026-01-01T00:00:03.000Z', text: 'no id' },
        'drop-me',
      ])
    );
    const duplicate = parseInboxMessageListRaw(
      JSON.stringify([
        { messageId: 'same', timestamp: '2026-01-01T00:00:04.000Z', text: 'new' },
        { timestamp: 'not-a-date', text: 'invalid date' },
      ])
    );

    expect(mergeInboxMessageLists(canonical, [duplicate])).toEqual([
      { messageId: 'same', timestamp: '2026-01-01T00:00:04.000Z', text: 'new' },
      { timestamp: '2026-01-01T00:00:03.000Z', text: 'no id' },
      { messageId: 'keep', timestamp: '2026-01-01T00:00:02.000Z', text: 'keep' },
      { timestamp: 'not-a-date', text: 'invalid date' },
    ]);
    expect(parseInboxMessageListRaw('{not json')).toEqual([]);
  });

  it('dedupes legacy inbox rows without persisted messageId by effective identity', () => {
    const canonical = parseInboxMessageListRaw(
      JSON.stringify([
        {
          from: 'alice',
          timestamp: '2026-01-01T00:00:00.000Z',
          text: 'legacy duplicate',
          read: false,
          summary: 'old',
        },
        {
          from: 'alice',
          timestamp: '2026-01-01T00:00:01.000Z',
          text: 'legacy distinct',
          read: false,
        },
      ])
    );
    const duplicate = parseInboxMessageListRaw(
      JSON.stringify([
        {
          from: 'alice',
          timestamp: '2026-01-01T00:00:00.000Z',
          text: 'legacy duplicate',
          read: true,
          summary: 'new',
        },
        {
          from: 'alice',
          timestamp: '2026-01-01T00:00:02.000Z',
          text: 'legacy unique',
          read: false,
        },
      ])
    );

    expect(mergeInboxMessageLists(canonical, [duplicate])).toEqual([
      {
        from: 'alice',
        timestamp: '2026-01-01T00:00:02.000Z',
        text: 'legacy unique',
        read: false,
      },
      {
        from: 'alice',
        timestamp: '2026-01-01T00:00:01.000Z',
        text: 'legacy distinct',
        read: false,
      },
      {
        from: 'alice',
        timestamp: '2026-01-01T00:00:00.000Z',
        text: 'legacy duplicate',
        read: true,
        summary: 'new',
      },
    ]);
  });
});

describe('team provisioning members.meta payload planning', () => {
  it('builds normalized members.meta payloads for provisioning members', () => {
    const members: TeamCreateRequest['members'] = [
      {
        name: ' Builder ',
        role: ' Implement ',
        workflow: ' Ship changes ',
        isolation: 'worktree',
        cwd: ' /repo/builder ',
        providerId: 'codex',
        model: ' gpt-5.4 ',
        effort: 'high',
        fastMode: 'on',
        mcpPolicy: { mode: 'appOnly' },
        joinedAt: 123,
      } as TeamCreateRequest['members'][number] & { joinedAt: number },
    ];

    expect(buildMembersMetaWritePayload(members)[0]).toMatchObject({
      name: 'Builder',
      role: 'Implement',
      workflow: 'Ship changes',
      isolation: 'worktree',
      cwd: '/repo/builder',
      providerId: 'codex',
      model: 'gpt-5.4',
      effort: 'high',
      fastMode: 'on',
      mcpPolicy: { mode: 'appOnly' },
      agentType: 'general-purpose',
      joinedAt: 123,
    });
  });

  it('preserves tombstones across launch persistence and excludes stale active duplicates', () => {
    const removedAt = Date.parse('2026-07-14T17:00:00.000Z');
    const active = buildMembersMetaWritePayload([
      { name: 'alice', role: 'stale launch input' },
      { name: 'bob', role: 'remaining teammate' },
    ]);

    expect(
      mergeMembersMetaForLaunch(active, [
        { name: 'Alice', role: 'removed teammate', removedAt },
        { name: 'bob', role: 'previous metadata' },
      ])
    ).toEqual([
      expect.objectContaining({ name: 'bob', role: 'remaining teammate' }),
      { name: 'Alice', role: 'removed teammate', removedAt },
    ]);
  });
});
