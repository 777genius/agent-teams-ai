import { compileHostedPromotionPlan } from '@features/team-configuration';
import { describe, expect, it } from 'vitest';

const input = { runtimeWorkspaceId: 'workspace_runtime', originalTeamId: 'team_original',
  admittedWorkspaceRoot: '/sandbox/project', laneIds: ['lane_first'], configuration: {
    schemaVersion: 1, toolApprovalMode: 'auto', lanes: [{ kind: 'opencode', provider: 'opencode',
      selectedModel: 'openai/gpt-6', effort: 'medium', members: [{ name: 'builder', prompt: 'Do work.' }] }],
  } };

describe('exact Owner schema2 private plan compiler', () => {
  it('has the exact Owner field order, no newline or capability fields', () => {
    expect(compileHostedPromotionPlan(input)).toBe('{"schemaVersion":2,"workspaceId":"workspace_runtime","teamId":"team_original","workspaceRoot":"/sandbox/project","toolApprovalMode":"auto","lanes":[{"laneId":"lane_first","kind":"opencode","provider":"opencode","selectedModel":"openai/gpt-6","effort":"medium","members":[{"name":"builder","prompt":"Do work."}]}]}');
  });
  it('preserves explicit manual mode without advertising support or switching to auto', () => {
    expect(JSON.parse(compileHostedPromotionPlan({ ...input, configuration: { ...input.configuration, toolApprovalMode: 'manual' } })).toolApprovalMode).toBe('manual');
  });
  it.each(['anthropic', 'codex', 'gemini'])('encodes %s without claiming a supported runtime', (provider) => {
    const plan = JSON.parse(compileHostedPromotionPlan({ ...input, configuration: { schemaVersion: 1, toolApprovalMode: 'auto',
      lanes: [{ kind: 'native', provider, members: [{ name: 'builder', prompt: 'Work.', model: 'model-1' }] }] } }));
    expect(plan.lanes[0]).toEqual({ laneId: 'lane_first', kind: 'native', provider, members: [{ name: 'builder', prompt: 'Work.', model: 'model-1' }] });
  });
  it('rejects unsupported inputs and malformed ordering', () => {
    for (const patch of [{ laneIds: [] }, { admittedWorkspaceRoot: 'relative' }, { admittedWorkspaceRoot: '/bad\0root' },
      { configuration: { ...input.configuration, executable: '/bin/sh' } },
      { configuration: { ...input.configuration, lanes: [{ ...input.configuration.lanes[0], provider: 'unknown' }] } }]) {
      expect(() => compileHostedPromotionPlan({ ...input, ...patch })).toThrow();
    }
  });
  it('rejects bytes above the bounded roster/plan limit including multibyte prompts', () => {
    expect(() => compileHostedPromotionPlan({ ...input, configuration: { ...input.configuration,
      lanes: [{ ...input.configuration.lanes[0], members: [{ name: 'builder', prompt: '界'.repeat(65536) }] }] } })).toThrow();
    expect(new TextEncoder().encode(compileHostedPromotionPlan(input)).length).toBeLessThanOrEqual(256 * 1024);
  });
});
