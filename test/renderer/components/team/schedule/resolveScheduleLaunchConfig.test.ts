import { describe, expect, it } from 'vitest';

import {
  markScheduleProviderSwitch,
  resolveScheduleLaunchConfig,
  type ScheduleRuntimeEdits,
} from '@renderer/components/team/schedule/resolveScheduleLaunchConfig';

import type { Schedule, ScheduleLaunchConfig } from '@shared/types';

const oldConfig: ScheduleLaunchConfig = {
  cwd: '/tmp/sandbox',
  prompt: 'Check PRs',
  providerId: 'anthropic',
  model: 'claude-opus-4-6',
  fastMode: 'on',
  resolvedFastMode: true,
  skipPermissions: false,
};
const schedule: Schedule = {
  id: 'schedule-1',
  teamName: 'sandbox-team',
  executionMode: 'agent',
  cronExpression: '0 9 * * *',
  timezone: 'UTC',
  status: 'active',
  warmUpMinutes: 0,
  maxConsecutiveFailures: 3,
  consecutiveFailures: 0,
  maxTurns: 50,
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
  launchConfig: oldConfig,
};
const edits = (changes: Partial<ScheduleRuntimeEdits> = {}): ScheduleRuntimeEdits => ({
  provider: false,
  model: false,
  effort: false,
  fastMode: false,
  skipPermissions: false,
  ...changes,
});
const updatedModel: ScheduleLaunchConfig = {
  ...oldConfig,
  model: 'claude-sonnet-4-5',
  resolvedFastMode: false,
  skipPermissions: true,
};
const resolve = (
  edited: ScheduleRuntimeEdits,
  proposed: ScheduleLaunchConfig = updatedModel
): ScheduleLaunchConfig => resolveScheduleLaunchConfig({
  schedule,
  mode: 'agent',
  taskFirst: false,
  savedTeam: null,
  edited,
  proposed,
});

describe('safe scheduled runtime configuration', () => {
  it('retains the exact original values on an unrelated schedule edit', () => {
    expect(resolve(edits())).toMatchObject(oldConfig);
  });

  it('recalculates resolved Fast mode when a selected model loses Fast support', () => {
    const result = resolve(edits({ model: true, effort: true }));
    expect(result).toMatchObject({
      providerId: 'anthropic',
      model: 'claude-sonnet-4-5',
      fastMode: 'on',
      resolvedFastMode: false,
      skipPermissions: false,
    });
  });

  it('preserves Fast mode resolution when only permissions change', () => {
    const result = resolve(edits({ skipPermissions: true }));
    expect(result).toMatchObject({
      model: 'claude-opus-4-6',
      fastMode: 'on',
      resolvedFastMode: true,
      skipPermissions: true,
    });
  });

  it('switches provider-specific settings together when a hidden provider is edited', () => {
    const edited = edits();
    markScheduleProviderSwitch(edited, 'gemini', 'anthropic');
    expect(edited).toMatchObject({
      provider: true, model: true, effort: true, fastMode: true,
    });
    const result = resolveScheduleLaunchConfig({
      schedule: { ...schedule, launchConfig: { ...oldConfig, providerId: 'gemini' } },
      mode: 'agent',
      taskFirst: false,
      savedTeam: null,
      edited,
      proposed: updatedModel,
    });
    expect(result).toMatchObject({
      providerId: 'anthropic', model: 'claude-sonnet-4-5', resolvedFastMode: false,
    });
  });

  it('leaves omitted legacy runtime fields omitted when no runtime control was edited', () => {
    const result = resolveScheduleLaunchConfig({
      schedule: { ...schedule, launchConfig: { cwd: '/tmp/sandbox', prompt: 'Check PRs', providerId: 'gemini' } },
      mode: 'agent',
      taskFirst: false,
      savedTeam: null,
      edited: edits(),
      proposed: updatedModel,
    });
    expect(result).toMatchObject({
      providerId: 'gemini', model: undefined, fastMode: undefined,
      resolvedFastMode: undefined, skipPermissions: undefined,
    });
  });

  it('never persists one-shot model or Fast mode into task-first team assignments', () => {
    const result = resolveScheduleLaunchConfig({
      schedule: null,
      mode: 'team',
      taskFirst: true,
      savedTeam: { providerId: 'codex', providerBackendId: 'codex-native' },
      edited: edits(),
      proposed: updatedModel,
    });
    expect(result).toMatchObject({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: undefined,
      effort: undefined,
      fastMode: undefined,
      resolvedFastMode: undefined,
      skipPermissions: undefined,
    });
  });
});
