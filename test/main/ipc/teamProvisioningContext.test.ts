import { describe, expect, it, vi } from 'vitest';

import { hostTeamSelectionKey } from '../../../src/features/agent-backend/contracts';
import { createPrepareProvisioningHandler } from '../../../src/main/ipc/teams/createPrepareProvisioningHandler';
import { bindTeamProvisioningContext } from '../../../src/shared/utils/teamProvisioningContext';

import type { TeamsAPI } from '../../../src/shared/types/api';
import type { IpcMainInvokeEvent } from 'electron';

const event = {} as IpcMainInvokeEvent;
const choices = [
  '/TEST/context',
  'anthropic',
  ['anthropic'],
  ['opus'],
  false,
  'deep',
  [{ providerId: 'anthropic', model: 'opus', effort: 'medium' }],
] as const;

describe('existing dialog provisioning destination', () => {
  it('deeply captures member references rather than retaining mutable roster objects', async () => {
    const prepare = vi
      .fn<TeamsAPI['prepareProvisioning']>()
      .mockResolvedValue({ ready: true, message: 'TEST' });
    const target = { kind: 'member' as const, name: 'Bob', originalName: 'Original' };
    const checks = [{ providerId: 'anthropic' as const, model: 'opus', targets: [target] }];
    const captured = bindTeamProvisioningContext(prepare, {
      kind: 'team',
      teamName: hostTeamSelectionKey('TEST'),
      selectedModelChecks: checks,
    });
    target.name = 'Late mutation';
    checks[0]!.targets.push({ ...target });
    await captured('/TEST/context', 'anthropic');
    expect(prepare.mock.calls[0]?.[7]).toMatchObject({
      selectedModelChecks: [
        { targets: [{ kind: 'member', name: 'Bob', originalName: 'Original' }] },
      ],
    });
  });
  it('retains provider-specific efforts without narrowing the existing Codex/OpenCode UI contract', async () => {
    const prepare = vi
      .fn<TeamsAPI['prepareProvisioning']>()
      .mockResolvedValue({ ready: true, message: 'TEST' });
    for (const effort of ['none', 'minimal', 'ultra'] as const) {
      const captured = bindTeamProvisioningContext(prepare, {
        kind: 'team',
        teamName: 'legacy-codex',
        selectedModelChecks: [{ providerId: 'codex', model: 'TEST-model', effort }],
      });
      await captured('/TEST/context', 'codex');
      expect(prepare.mock.calls.at(-1)?.[7]).toEqual({
        kind: 'team',
        teamName: 'legacy-codex',
        selectedModelChecks: [{ providerId: 'codex', model: 'TEST-model', effort }],
      });
    }
  });
  it('routes normalized Host checks through the captured port and retains choices on a cached runtime-only stage', async () => {
    const legacy = vi.fn();
    const host = vi.fn(async () => ({ ready: true, message: 'captured' }));
    const handler = createPrepareProvisioningHandler(legacy, () => true, host);
    const prepare: TeamsAPI['prepareProvisioning'] = async (...args) => {
      const result = await handler(event, ...args);
      if (!result.success || !result.data) throw new Error(result.error);
      return result.data;
    };
    const checks = [{ providerId: 'anthropic' as const, model: 'opus', effort: 'medium' as const }];
    const captured = bindTeamProvisioningContext(prepare, {
      kind: 'team',
      teamName: hostTeamSelectionKey('TEST-original'),
      selectedModelChecks: checks,
      preparationId: 'TEST-explicit-check',
    });
    checks[0]!.model = 'TEST-late-change';
    expect((await captured('/TEST/context', 'anthropic', ['anthropic'])).ready).toBe(true);
    expect(host).toHaveBeenCalledWith(
      event,
      {
        kind: 'team',
        teamName: hostTeamSelectionKey('TEST-original'),
        selectedModelChecks: [{ providerId: 'anthropic', model: 'opus', effort: 'medium' }],
        preparationId: 'TEST-explicit-check',
      },
      '/TEST/context',
      expect.objectContaining({ providerId: 'anthropic' })
    );
    expect(legacy).not.toHaveBeenCalled();
    host.mockClear();
    expect(
      await handler(
        event,
        '/TEST/context',
        'anthropic',
        ['anthropic'],
        ['opus'],
        'bad',
        undefined,
        checks,
        { kind: 'team', teamName: hostTeamSelectionKey('TEST-original') }
      )
    ).toMatchObject({ success: false });
    expect(host).not.toHaveBeenCalled();
  });
  it('retains the original Team across all stages and refuses Host checks before any fork call', async () => {
    const legacy = vi.fn(async () => ({ success: true, data: { ready: true, message: 'legacy' } }));
    const handler = createPrepareProvisioningHandler(legacy, () => false);
    const prepare: TeamsAPI['prepareProvisioning'] = async (...args) => {
      const result = await handler(event, ...args);
      if (!result.success || !result.data) throw new Error(result.error);
      return result.data;
    };
    const context = { kind: 'team' as const, teamName: hostTeamSelectionKey('TEST-original') };
    const captured = bindTeamProvisioningContext(prepare, context);
    context.teamName = 'same-display-legacy';
    expect((await captured('/TEST/context', 'anthropic')).ready).toBe(false);
    expect(
      (await captured('/TEST/context', 'anthropic', ['anthropic'], ['opus'], false, 'deep')).ready
    ).toBe(false);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('does not use fork preflight for new-create or unscoped requests on a selected Host', async () => {
    const legacy = vi.fn();
    const handler = createPrepareProvisioningHandler(legacy, () => true);
    for (const context of [
      undefined,
      { kind: 'create' },
      { kind: 'team', teamName: 'host-team:%' },
    ]) {
      expect(await handler(event, ...choices, context)).toMatchObject({
        success: true,
        data: { ready: false },
      });
    }
    expect(legacy).not.toHaveBeenCalled();
  });

  it('keeps the existing normalized legacy preflight for captured legacy Teams and an unselected create', async () => {
    const legacy = vi.fn(async () => ({ success: true, data: { ready: true, message: 'legacy' } }));
    for (const [selected, context] of [
      [true, { kind: 'team', teamName: 'legacy-team' }],
      [false, { kind: 'create' }],
      [false, undefined],
    ] as const) {
      const result = await createPrepareProvisioningHandler(legacy, () => selected)(
        event,
        ...choices,
        context
      );
      expect(result).toMatchObject({ success: true, data: { ready: true } });
    }
    expect(legacy).toHaveBeenCalledTimes(3);
    expect(legacy).toHaveBeenLastCalledWith('/TEST/context', {
      providerId: 'anthropic',
      providerIds: ['anthropic'],
      modelIds: ['opus'],
      limitContext: false,
      modelVerificationMode: 'deep',
      modelChecks: [{ providerId: 'anthropic', model: 'opus', effort: 'medium' }],
    });
  });

  it('rejects malformed context rather than dropping it and falling through to a legacy owner', async () => {
    const legacy = vi.fn();
    const handler = createPrepareProvisioningHandler(legacy, () => false);
    for (const context of [
      null,
      {},
      { kind: 'team', teamName: '' },
      { kind: 'create', owner: 'private' },
      {
        kind: 'team',
        teamName: 'host-team:TEST',
        selectedModelChecks: [
          {
            providerId: 'anthropic',
            model: 'opus',
            targets: [{ kind: 'member', name: 'Bob', memberId: 'private-override' }],
          },
        ],
      },
      {
        kind: 'team',
        teamName: 'host-team:TEST',
        selectedModelChecks: [
          { providerId: 'anthropic', model: 'opus', targets: [{ kind: 'lead', name: 'Bob' }] },
        ],
      },
      { kind: 'team', teamName: 'host-team:TEST', preparationId: '' },
      { kind: 'team', teamName: 'host-team:TEST', preparationId: undefined },
      Object.assign(Object.create({ preparationId: 'TEST-inherited' }) as object, {
        kind: 'team',
        teamName: 'host-team:TEST',
      }),
      {
        kind: 'team',
        teamName: 'host-team:TEST',
        selectedModelChecks: [{ providerId: 'anthropic', model: 'opus', executable: '/private' }],
      },
      { kind: 'team', teamName: 'host-team:TEST', selectedModelChecks: [undefined] },
      Object.assign(Object.create({ kind: 'team' }) as object, { teamName: 'legacy', extra: true }),
    ]) {
      expect(await handler(event, ...choices, context)).toEqual({
        success: false,
        error: 'Invalid provisioning context',
      });
    }
    expect(legacy).not.toHaveBeenCalled();
  });
});
