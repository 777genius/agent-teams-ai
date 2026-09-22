import {
  HOSTED_MVP_TOOL_APPROVAL_MODE,
  isHostedMvpApprovalModeAvailable,
  isHostedMvpManualApprovalAvailable,
  parseHostedRosterConfiguration,
} from '@features/team-configuration/contracts';
import { describe, expect, it } from 'vitest';

const manualConfiguration = {
  schemaVersion: 1,
  toolApprovalMode: 'manual',
  lanes: [
    {
      kind: 'native',
      provider: 'codex',
      members: [{ name: 'lead', prompt: 'Coordinate.', model: 'gpt-6' }],
    },
  ],
} as const;

describe('Hosted MVP approval-mode policy', () => {
  it('keeps manual records parse-compatible but admits only explicit automatic mode', () => {
    const parsed = parseHostedRosterConfiguration(manualConfiguration);
    expect(parsed.toolApprovalMode).toBe('manual');
    expect(isHostedMvpManualApprovalAvailable()).toBe(false);
    expect(HOSTED_MVP_TOOL_APPROVAL_MODE).toBe('auto');
    expect(isHostedMvpApprovalModeAvailable(parsed)).toBe(false);
    expect(isHostedMvpApprovalModeAvailable({ toolApprovalMode: 'auto' })).toBe(true);
  });
});
