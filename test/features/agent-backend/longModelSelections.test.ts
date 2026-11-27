// @vitest-environment node
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseBackendTeamOperation } from '../../../src/features/agent-backend/main/adapters/input/teamOperationValues';
import { projectLaunchModelConfiguration } from '../../../src/features/agent-backend/main/adapters/output/projectLaunchConfiguration';
import {
  parseRosterReplacement,
  rosterSavedSettings,
  rosterSettings,
} from '../../../src/features/agent-backend/main/adapters/rosterValues';
import { captureConfiguredHostTeamDraft } from '../../../src/features/agent-backend/main/application/createConfiguredHostTeam';

const revision = 'a'.repeat(64);
const cwd = resolve('TEST-model-workspace');
const probe = (model: string) => ({
  launchId: 'TEST-launch',
  rosterRevision: revision,
  memberId: 'lead',
  model,
});
const replacement = (model: string) => ({
  expectedRevision: revision,
  members: [{ name: 'worker', providerId: 'opencode', model }],
  savedSettings: { cwd, providerId: 'opencode', model },
  memberSettingsRelaunch: {
    memberName: 'team-lead',
    targetKind: 'lead',
    expectedFingerprint: revision,
    expectedTeamSettingsFingerprint: revision,
    baseline: [{ memberName: 'team-lead', expectedFingerprint: revision }],
    model,
    effort: null,
  },
});

describe('qualified model identity across existing Team controls', () => {
  it.each([
    'p'.repeat(180) + '/' + 'm'.repeat(160),
    'p'.repeat(256) + '/' + 'm'.repeat(256),
    'p'.repeat(180) + '/' + 'vendor/' + 'm'.repeat(160),
  ])(
    'preserves all components through save, relaunch, probe and launch projection (%#)',
    (model) => {
      const draft = captureConfiguredHostTeamDraft('TEST-context', {
        teamName: 'test-team',
        cwd,
        providerId: 'opencode',
        model,
        members: [{ name: 'worker', providerId: 'opencode', model }],
      });
      expect(draft.savedSettings.model).toBe(model);
      expect(draft.members[0]!.memberSettings.model).toBe(model);
      expect(rosterSettings({ providerId: 'opencode', model }, true).model).toBe(model);
      expect(rosterSavedSettings(draft.savedSettings, false).model).toBe(model);
      expect(parseRosterReplacement(replacement(model))).toEqual(replacement(model));
      expect(parseBackendTeamOperation('team.launch.probe.start', probe(model))).toEqual(
        probe(model)
      );
      const start = {
        launchId: 'TEST-launch',
        rosterRevision: revision,
        configuration: { members: [{ memberId: 'lead', model }] },
      };
      expect(parseBackendTeamOperation('team.launch.start', start)).toEqual(start);
      const source = { sourceId: 'TEST-source', rosterRevision: revision };
      const members = [
        {
          memberId: 'lead',
          label: 'team-lead',
          role: 'lead',
          selected: { provider: 'opencode', model, workspace: cwd, capabilities: ['model'] },
        },
      ];
      expect(projectLaunchModelConfiguration({ source, members })).toEqual({ source, members });
    }
  );

  it.each([
    'm'.repeat(257),
    'p'.repeat(257) + '/m',
    'p/' + 'm'.repeat(257),
    'p'.repeat(256) + '/' + 'm'.repeat(257),
    'p'.repeat(180) + '/bad\0model' + 'm'.repeat(160),
  ])('rejects a long selection that exceeds a native component or contains NUL (%#)', (model) => {
    expect(() => rosterSettings({ model }, true)).toThrow();
    expect(() => rosterSavedSettings({ cwd, model }, true)).toThrow();
    expect(() => parseRosterReplacement(replacement(model))).toThrow();
    expect(() => parseBackendTeamOperation('team.launch.probe.start', probe(model))).toThrow();
  });

  it('keeps non-model destination identifiers bounded', () => {
    expect(() =>
      parseBackendTeamOperation('team.launch.probe.start', {
        ...probe('TEST-model'),
        memberId: 'm'.repeat(257),
      })
    ).toThrow();
  });
});
