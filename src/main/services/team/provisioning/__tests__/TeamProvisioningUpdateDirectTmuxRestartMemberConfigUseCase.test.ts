import { describe, expect, it } from 'vitest';

import {
  createUpdateDirectTmuxRestartMemberConfigUseCase,
  type DirectTmuxRestartMemberConfigInput,
} from '../TeamProvisioningUpdateDirectTmuxRestartMemberConfigUseCase';

function restartInput(
  memberName: string,
  prompt: string,
  joinedAt: number
): DirectTmuxRestartMemberConfigInput {
  return {
    teamName: 'team-a',
    memberName,
    member: { name: memberName, providerId: 'codex' },
    agentId: `${memberName}@team-a`,
    color: 'blue',
    prompt,
    paneId: `%${joinedAt}`,
    cwd: '/safe-test-project',
    providerId: 'codex',
    joinedAt,
    bootstrapExpectedAfter: '2026-07-09T00:00:00.000Z',
  };
}

function memberPrompts(raw: string): Record<string, string> {
  const parsed = JSON.parse(raw) as {
    members?: Array<{ name?: string; prompt?: string }>;
  };
  return Object.fromEntries(
    (parsed.members ?? []).map((member) => [member.name ?? '', member.prompt ?? ''])
  );
}

describe('TeamProvisioningUpdateDirectTmuxRestartMemberConfigUseCase', () => {
  it('updates an existing direct restart member config without host/service state', async () => {
    const writes: Array<{ teamName: string; contents: string }> = [];
    const invalidated: string[] = [];
    const useCase = createUpdateDirectTmuxRestartMemberConfigUseCase({
      async readTeamConfigJson() {
        return JSON.stringify({
          name: 'Team A',
          members: [
            {
              name: 'Worker',
              subscriptions: ['updates'],
              staleField: 'preserved',
            },
          ],
        });
      },
      async writeTeamConfigJson(teamName, contents) {
        writes.push({ teamName, contents });
      },
      invalidateTeamConfig(teamName) {
        invalidated.push(teamName);
      },
    });

    await useCase({
      teamName: 'team-a',
      memberName: 'worker',
      member: {
        name: 'Worker',
        role: 'Developer',
        providerId: 'codex',
        agentType: 'general-purpose',
        model: 'gpt-5',
        effort: 'medium',
      },
      agentId: 'Worker@team-a',
      color: 'blue',
      prompt: 'restart prompt',
      paneId: 'process:123',
      cwd: '/safe-test-project',
      providerId: 'codex',
      joinedAt: 123,
      bootstrapExpectedAfter: '2026-07-09T00:00:00.000Z',
      backendType: 'process',
      runtimePid: 123,
      bootstrapRuntimeEventsPath: '/safe-test-project/runtime/worker.runtime.jsonl',
      bootstrapProofToken: 'proof-token',
      bootstrapRunId: 'run-1',
      bootstrapContextHash: 'context-hash',
      bootstrapBriefingHash: 'briefing-hash',
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.teamName).toBe('team-a');
    expect(JSON.parse(writes[0]?.contents ?? '{}')).toEqual({
      name: 'Team A',
      members: [
        {
          name: 'Worker',
          subscriptions: ['updates'],
          staleField: 'preserved',
          agentId: 'Worker@team-a',
          role: 'Developer',
          agentType: 'general-purpose',
          provider: 'codex',
          providerId: 'codex',
          model: 'gpt-5',
          effort: 'medium',
          prompt: 'restart prompt',
          color: 'blue',
          joinedAt: 123,
          bootstrapExpectedAfter: '2026-07-09T00:00:00.000Z',
          bootstrapProofToken: 'proof-token',
          bootstrapRunId: 'run-1',
          bootstrapRuntimeEventsPath: '/safe-test-project/runtime/worker.runtime.jsonl',
          bootstrapProofMode: 'native_app_managed_context',
          bootstrapContextHash: 'context-hash',
          bootstrapBriefingHash: 'briefing-hash',
          tmuxPaneId: 'process:123',
          runtimePid: 123,
          cwd: '/safe-test-project',
          backendType: 'process',
        },
      ],
    });
    expect(writes[0]?.contents.endsWith('\n')).toBe(true);
    expect(invalidated).toEqual(['team-a']);
  });

  it('adds a missing member with default tmux backend and empty subscriptions', async () => {
    let written = '';
    const useCase = createUpdateDirectTmuxRestartMemberConfigUseCase({
      async readTeamConfigJson() {
        return JSON.stringify({ name: 'Team A', members: [] });
      },
      async writeTeamConfigJson(_teamName, contents) {
        written = contents;
      },
      invalidateTeamConfig() {
        return undefined;
      },
    });

    await useCase({
      teamName: 'team-a',
      memberName: 'Worker',
      member: { name: 'Worker', providerId: 'anthropic' },
      agentId: 'Worker@team-a',
      color: 'green',
      prompt: 'prompt',
      paneId: '%1',
      cwd: '/safe-test-project',
      providerId: 'anthropic',
      joinedAt: 456,
      bootstrapExpectedAfter: '2026-07-09T00:00:00.000Z',
    });

    expect(JSON.parse(written).members).toEqual([
      expect.objectContaining({
        name: 'Worker',
        provider: 'anthropic',
        providerId: 'anthropic',
        subscriptions: [],
        backendType: 'tmux',
      }),
    ]);
  });

  it('persists two disjoint member updates sequentially as a control', async () => {
    let persisted = JSON.stringify({
      name: 'Team A',
      members: [{ name: 'Worker A' }, { name: 'Worker B' }],
    });
    const useCase = createUpdateDirectTmuxRestartMemberConfigUseCase({
      async readTeamConfigJson() {
        return persisted;
      },
      async writeTeamConfigJson(_teamName, contents) {
        persisted = contents;
      },
      invalidateTeamConfig() {
        return undefined;
      },
    });

    await useCase(restartInput('Worker A', 'prompt-a', 1));
    await useCase(restartInput('Worker B', 'prompt-b', 2));

    expect(memberPrompts(persisted)).toMatchObject({
      'Worker A': 'prompt-a',
      'Worker B': 'prompt-b',
    });
  });

  it('serializes concurrent disjoint member updates so neither whole-file write is lost', async () => {
    let persisted = JSON.stringify({
      name: 'Team A',
      members: [{ name: 'Worker A' }, { name: 'Worker B' }],
    });
    let readCount = 0;
    let writeCount = 0;
    let signalFirstWriteStarted!: () => void;
    let releaseFirstWrite!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      signalFirstWriteStarted = resolve;
    });
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const useCase = createUpdateDirectTmuxRestartMemberConfigUseCase({
      async readTeamConfigJson() {
        readCount += 1;
        return persisted;
      },
      async writeTeamConfigJson(_teamName, contents) {
        writeCount += 1;
        if (writeCount === 1) {
          signalFirstWriteStarted();
          await firstWriteGate;
        }
        persisted = contents;
      },
      invalidateTeamConfig() {
        return undefined;
      },
    });

    const first = useCase(restartInput('Worker A', 'prompt-a', 1));
    await firstWriteStarted;
    const second = useCase(restartInput('Worker B', 'prompt-b', 2));

    expect(readCount).toBe(1);
    releaseFirstWrite();
    await Promise.all([first, second]);

    expect(readCount).toBe(2);
    expect(writeCount).toBe(2);
    expect(memberPrompts(persisted)).toMatchObject({
      'Worker A': 'prompt-a',
      'Worker B': 'prompt-b',
    });
  });

  it('fails before writing when the team config is unavailable', async () => {
    const writes: string[] = [];
    const useCase = createUpdateDirectTmuxRestartMemberConfigUseCase({
      async readTeamConfigJson() {
        return null;
      },
      async writeTeamConfigJson(_teamName, contents) {
        writes.push(contents);
      },
      invalidateTeamConfig() {
        return undefined;
      },
    });

    await expect(
      useCase({
        teamName: 'missing-team',
        memberName: 'Worker',
        member: { name: 'Worker', providerId: 'codex' },
        agentId: 'Worker@missing-team',
        color: 'blue',
        prompt: 'prompt',
        paneId: '%1',
        cwd: '/safe-test-project',
        providerId: 'codex',
        joinedAt: 1,
        bootstrapExpectedAfter: '2026-07-09T00:00:00.000Z',
      })
    ).rejects.toThrow('Team "missing-team" configuration is no longer available');
    expect(writes).toEqual([]);
  });
});
