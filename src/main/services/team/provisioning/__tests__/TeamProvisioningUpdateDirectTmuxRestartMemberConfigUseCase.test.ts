import { describe, expect, it, vi } from 'vitest';

import { TeamConfigReader } from '../../TeamConfigReader';
import { getTeamDataWorkerClient } from '../../TeamDataWorkerClient';
import {
  createNodeUpdateDirectTmuxRestartMemberConfigUseCasePorts,
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
  it('invalidates main and worker-backed team config caches through the node adapter', () => {
    const mainInvalidation = vi.spyOn(TeamConfigReader, 'invalidateTeam').mockImplementation(() => {
      return undefined;
    });
    const workerInvalidation = vi
      .spyOn(getTeamDataWorkerClient(), 'invalidateTeamConfig')
      .mockImplementation(() => {
        return undefined;
      });

    createNodeUpdateDirectTmuxRestartMemberConfigUseCasePorts().invalidateTeamConfig('team-a');

    expect(mainInvalidation).toHaveBeenCalledOnce();
    expect(mainInvalidation).toHaveBeenCalledWith('team-a');
    expect(workerInvalidation).toHaveBeenCalledOnce();
    expect(workerInvalidation).toHaveBeenCalledWith('team-a');
    expect(mainInvalidation.mock.invocationCallOrder[0]).toBeLessThan(
      workerInvalidation.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );

    mainInvalidation.mockRestore();
    workerInvalidation.mockRestore();
  });

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

  it('clears stale process runtime metadata when restarting the member in tmux', async () => {
    let written = '';
    const useCase = createUpdateDirectTmuxRestartMemberConfigUseCase({
      async readTeamConfigJson() {
        return JSON.stringify({
          name: 'Team A',
          members: [
            {
              name: 'Worker',
              backendType: 'process',
              tmuxPaneId: 'process:123',
              runtimePid: 123,
              runtimeSessionId: 'old-process-session',
              bootstrapRuntimeEventsPath: '/safe-test-project/runtime/old.runtime.jsonl',
              bootstrapProofToken: 'old-proof-token',
              bootstrapRunId: 'old-run',
              bootstrapProofMode: 'native_app_managed_context',
              bootstrapContextHash: 'old-context-hash',
              bootstrapBriefingHash: 'old-briefing-hash',
              staleField: 'preserved',
            },
          ],
        });
      },
      async writeTeamConfigJson(_teamName, contents) {
        written = contents;
      },
      invalidateTeamConfig() {
        return undefined;
      },
    });

    await useCase(restartInput('Worker', 'tmux restart prompt', 456));

    const parsed = JSON.parse(written) as { members: Record<string, unknown>[] };
    const member = parsed.members[0] ?? {};
    expect(member).toMatchObject({
      name: 'Worker',
      backendType: 'tmux',
      tmuxPaneId: '%456',
      bootstrapExpectedAfter: '2026-07-09T00:00:00.000Z',
      staleField: 'preserved',
    });
    expect(member).not.toHaveProperty('runtimePid');
    expect(member).not.toHaveProperty('runtimeSessionId');
    expect(member).not.toHaveProperty('bootstrapRuntimeEventsPath');
    expect(member).not.toHaveProperty('bootstrapProofToken');
    expect(member).not.toHaveProperty('bootstrapRunId');
    expect(member).not.toHaveProperty('bootstrapProofMode');
    expect(member).not.toHaveProperty('bootstrapContextHash');
    expect(member).not.toHaveProperty('bootstrapBriefingHash');
  });

  it('preserves newly supplied runtime metadata during a process-to-tmux transition', async () => {
    let written = '';
    const useCase = createUpdateDirectTmuxRestartMemberConfigUseCase({
      async readTeamConfigJson() {
        return JSON.stringify({
          name: 'Team A',
          members: [
            {
              name: 'Worker',
              backendType: 'process',
              runtimePid: 123,
              bootstrapRuntimeEventsPath: '/safe-test-project/runtime/old.runtime.jsonl',
              bootstrapProofToken: 'old-proof-token',
              bootstrapRunId: 'old-run',
              bootstrapProofMode: 'old-proof-mode',
              bootstrapContextHash: 'old-context-hash',
              bootstrapBriefingHash: 'old-briefing-hash',
            },
          ],
        });
      },
      async writeTeamConfigJson(_teamName, contents) {
        written = contents;
      },
      invalidateTeamConfig() {
        return undefined;
      },
    });

    await useCase({
      ...restartInput('Worker', 'tmux restart prompt', 456),
      runtimePid: 789,
      bootstrapRuntimeEventsPath: '/safe-test-project/runtime/new.runtime.jsonl',
      bootstrapProofToken: 'new-proof-token',
      bootstrapRunId: 'new-run',
      bootstrapContextHash: 'new-context-hash',
      bootstrapBriefingHash: 'new-briefing-hash',
    });

    const parsed = JSON.parse(written) as { members: Record<string, unknown>[] };
    expect(parsed.members[0]).toMatchObject({
      backendType: 'tmux',
      runtimePid: 789,
      bootstrapRuntimeEventsPath: '/safe-test-project/runtime/new.runtime.jsonl',
      bootstrapProofToken: 'new-proof-token',
      bootstrapRunId: 'new-run',
      bootstrapProofMode: 'native_app_managed_context',
      bootstrapContextHash: 'new-context-hash',
      bootstrapBriefingHash: 'new-briefing-hash',
    });
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

  it('continues serialized mutations after a rejected update without committing the rejected state', async () => {
    let persisted = JSON.stringify({
      name: 'Team A',
      members: [{ name: 'Worker A' }, { name: 'Worker B' }],
    });
    const events: string[] = [];
    let writeCount = 0;
    const useCase = createUpdateDirectTmuxRestartMemberConfigUseCase({
      async readTeamConfigJson() {
        events.push('read');
        return persisted;
      },
      async writeTeamConfigJson(_teamName, contents) {
        writeCount += 1;
        events.push(`write-${writeCount}`);
        if (writeCount === 1) {
          throw new Error('rejected mutation');
        }
        persisted = contents;
      },
      invalidateTeamConfig() {
        events.push('invalidate');
      },
    });

    const rejected = expect(
      useCase(restartInput('Worker A', 'rejected-prompt', 1))
    ).rejects.toThrow('rejected mutation');
    const successful = useCase(restartInput('Worker B', 'accepted-prompt', 2));

    await rejected;
    await expect(successful).resolves.toBeUndefined();

    expect(events).toEqual(['read', 'write-1', 'read', 'write-2', 'invalidate']);
    expect(memberPrompts(persisted)).toMatchObject({
      'Worker A': '',
      'Worker B': 'accepted-prompt',
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

  it('fails with a clear error (not a raw SyntaxError) when the team config is corrupt', async () => {
    const writes: string[] = [];
    const useCase = createUpdateDirectTmuxRestartMemberConfigUseCase({
      async readTeamConfigJson() {
        // Torn/partial read - e.g. the runtime CLI writing config.json concurrently.
        return '{"name":"team", "members":[{"name":"Worker"';
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
        teamName: 'team',
        memberName: 'Worker',
        member: { name: 'Worker', providerId: 'codex' },
        agentId: 'Worker@team',
        color: 'blue',
        prompt: 'prompt',
        paneId: '%1',
        cwd: '/safe-test-project',
        providerId: 'codex',
        joinedAt: 1,
        bootstrapExpectedAfter: '2026-07-09T00:00:00.000Z',
      })
    ).rejects.toThrow(/configuration is currently unreadable/);
    expect(writes).toEqual([]);
  });
});
