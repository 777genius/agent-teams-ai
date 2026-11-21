import { describe, expect, it, vi } from 'vitest';

import { ApplicationCommandRunOutcome } from '../../src/features/application-command-ledger';
import { createMemberSettingsFingerprint, MemberSettingsCommandExecutor } from '../../src/features/team-provisioning/main';
import { createProjectMemberSettingsWriter } from '../../src/main/projectLiveMemberSettings';

import type { MemberSettingsTarget, UpdateMemberSettingsRequest, UpdateMemberSettingsResult } from '../../src/features/team-provisioning/contracts';

const settings = {
  role: 'developer', workflow: null, isolation: null, providerId: 'anthropic',
  providerBackendId: null, model: null, effort: null, fastMode: null, mcpPolicy: null,
} as const;
const logical: MemberSettingsTarget = {
  name: 'alice', agentType: 'developer', agentId: null, joinedAt: null, settings,
};
const physical: MemberSettingsTarget = {
  ...logical, agentId: 'alice@project', joinedAt: 10,
};
const request: UpdateMemberSettingsRequest = {
  commandId: 'command-1', idempotencyKey: 'command-1', teamName: 'builders', memberName: 'alice',
  expectedFingerprint: createMemberSettingsFingerprint(logical), targetKind: 'member',
  settings: { ...settings, role: 'reviewer' },
};

function completed(effect: 'persisted_only' | 'member_restart_started' | 'team_relaunch_required'): UpdateMemberSettingsResult {
  return { outcome: 'completed', effect, memberName: 'alice', previousFingerprint: 'previous',
    currentFingerprint: 'current', replayed: false };
}

function fixture(commands = new MemberSettingsCommandExecutor('test-project-settings')) {
  let pending = false;
  const order: string[] = [];
  const journal = {
    hasPending: vi.fn(async () => pending),
    begin: vi.fn(async () => { pending = true; }),
    clear: vi.fn(async () => { pending = false; }),
  };
  const running = { executionTeamName: 'ptc-a', runId: 'run-1' };
  const editor = {
    findRunningContextForEdit: vi.fn(async () => running),
    assertEditable: vi.fn(async () => { throw new Error('running'); }),
    projectToAliases: vi.fn(async () => ({ failed: [] })),
  };
  const team = {
    getMemberSettingsTarget: vi.fn(async ({ teamName }: { teamName: string }) => teamName === 'builders' ? logical : physical),
    updateMemberSettings: vi.fn(async (input: UpdateMemberSettingsRequest) => {
      order.push(input.teamName);
      return completed(input.teamName === 'builders' ? 'persisted_only' : 'member_restart_started');
    }),
  };
  const data = { runConfigurationOperation: async <T>(_name: string, operation: () => Promise<T>) => operation() };
  const writer = createProjectMemberSettingsWriter(
    { team, definitionLead: team }, { data: () => data } as never,
    commands, () => journal
  );
  return { journal, editor, team, writer, order, running, pending: () => pending };
}

describe('project live member settings', () => {
  it('updates the live member and definition once, using the physical identity and replaying retries', async () => {
    const f = fixture();
    const result = await f.writer(f.editor as never, request);
    expect(result).toMatchObject({ outcome: 'completed', effect: 'member_restart_started', currentFingerprint: 'current' });
    expect(f.order).toEqual(['ptc-a', 'builders']);
    expect(f.team.updateMemberSettings.mock.calls[0][0].expectedFingerprint).toBe(createMemberSettingsFingerprint(physical));
    expect(f.pending()).toBe(false);
    expect(await f.writer(f.editor as never, request)).toMatchObject({ replayed: true });
    expect(f.order).toEqual(['ptc-a', 'builders']);
  });

  it('uses the durable command result to replay without restarting the member twice', async () => {
    let stored: unknown;
    const runner = { run: vi.fn(async (_input: unknown, execute: () => Promise<unknown>) => {
      if (stored) return { outcome: ApplicationCommandRunOutcome.Replayed, result: stored };
      stored = await execute();
      return { outcome: ApplicationCommandRunOutcome.Executed, result: stored };
    }) };
    const f = fixture(new MemberSettingsCommandExecutor('test-project-settings', runner as never));
    await f.writer(f.editor as never, request);
    expect(await f.writer(f.editor as never, request)).toMatchObject({ replayed: true });
    expect(f.order).toEqual(['ptc-a', 'builders']);
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it('reports an uncertain interrupted durable command as recovery, without rerunning effects', async () => {
    const runner = { run: vi.fn(async (input: { reconcile: () => Promise<{ result: unknown }> }) => ({
      outcome: ApplicationCommandRunOutcome.Reconciled, result: (await input.reconcile()).result,
    })) };
    const f = fixture(new MemberSettingsCommandExecutor('test-project-settings', runner as never));
    expect(await f.writer(f.editor as never, request)).toMatchObject({ outcome: 'completed', effect: 'recovery_required' });
    expect(f.team.updateMemberSettings).not.toHaveBeenCalled();
  });

  it('does not save the definition when the native operation requires a full relaunch', async () => {
    const f = fixture();
    f.team.updateMemberSettings.mockResolvedValue(completed('team_relaunch_required'));
    const result = await f.writer(f.editor as never, request);
    expect(result).toMatchObject({ outcome: 'completed', effect: 'team_relaunch_required',
      previousFingerprint: request.expectedFingerprint, currentFingerprint: request.expectedFingerprint });
    expect(f.team.updateMemberSettings).toHaveBeenCalledOnce();
    expect(f.pending()).toBe(false);
  });

  it('retains a recovery fence when the active member changed but the definition save fails', async () => {
    const f = fixture();
    f.team.updateMemberSettings.mockImplementation(async (input) => {
      f.order.push(input.teamName);
      if (input.teamName === 'builders') throw new Error('disk error');
      return completed('member_restart_started');
    });
    expect(await f.writer(f.editor as never, request)).toMatchObject({ outcome: 'completed', effect: 'recovery_required' });
    expect(f.pending()).toBe(true);
    expect(await f.writer(f.editor as never, request)).toMatchObject({ effect: 'recovery_required', replayed: true });
    expect(f.order).toEqual(['ptc-a', 'builders']);
  });

  it('does not write the definition when the runtime identity changes after the live update', async () => {
    const f = fixture();
    f.team.updateMemberSettings.mockImplementation(async (input) => {
      f.order.push(input.teamName);
      f.running.runId = 'different-run';
      return completed('member_restart_started');
    });
    // Return distinct snapshots so a restart cannot mutate the previously admitted identity.
    f.editor.findRunningContextForEdit.mockImplementation(async () => ({ ...f.running }));
    expect(await f.writer(f.editor as never, request)).toMatchObject({ outcome: 'completed', effect: 'recovery_required' });
    expect(f.order).toEqual(['ptc-a']);
    expect(f.pending()).toBe(true);
  });

  it('refuses to replace settings that already differ in the running copy', async () => {
    const f = fixture();
    f.team.getMemberSettingsTarget.mockImplementation(async ({ teamName }) => teamName === 'builders'
      ? logical : { ...physical, settings: { ...settings, role: 'different' } });
    expect(await f.writer(f.editor as never, request)).toMatchObject({ outcome: 'refused', reason: 'project_running' });
    expect(f.team.updateMemberSettings).not.toHaveBeenCalled();
    expect(f.journal.begin).not.toHaveBeenCalled();
  });
});
