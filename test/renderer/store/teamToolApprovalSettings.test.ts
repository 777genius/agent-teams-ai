import { describe, expect, it } from 'vitest';

import { parseToolApprovalSettings } from '../../../src/renderer/store/team/teamToolApprovalSettings';
import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '../../../src/shared/types/team';

describe('teamToolApprovalSettings', () => {
  it('returns defaults for missing or invalid JSON', () => {
    expect(parseToolApprovalSettings(null)).toBe(DEFAULT_TOOL_APPROVAL_SETTINGS);
    expect(parseToolApprovalSettings('')).toBe(DEFAULT_TOOL_APPROVAL_SETTINGS);
    expect(parseToolApprovalSettings('{not json')).toBe(DEFAULT_TOOL_APPROVAL_SETTINGS);
  });

  it('parses valid complete settings', () => {
    expect(
      parseToolApprovalSettings(
        JSON.stringify({
          autoAllowAll: true,
          autoAllowFileEdits: true,
          autoAllowSafeBash: true,
          timeoutAction: 'allow',
          timeoutSeconds: 120,
        })
      )
    ).toEqual({
      autoAllowAll: true,
      autoAllowFileEdits: true,
      autoAllowSafeBash: true,
      timeoutAction: 'allow',
      timeoutSeconds: 120,
    });
  });

  it('falls back per field when values have invalid types', () => {
    expect(
      parseToolApprovalSettings(
        JSON.stringify({
          autoAllowAll: 'yes',
          autoAllowFileEdits: true,
          autoAllowSafeBash: 1,
          timeoutAction: 'maybe',
          timeoutSeconds: '60',
        })
      )
    ).toEqual({
      ...DEFAULT_TOOL_APPROVAL_SETTINGS,
      autoAllowFileEdits: true,
    });
  });

  it('accepts timeout actions allow, deny, and wait', () => {
    expect(parseToolApprovalSettings(JSON.stringify({ timeoutAction: 'allow' })).timeoutAction).toBe(
      'allow'
    );
    expect(parseToolApprovalSettings(JSON.stringify({ timeoutAction: 'deny' })).timeoutAction).toBe(
      'deny'
    );
    expect(parseToolApprovalSettings(JSON.stringify({ timeoutAction: 'wait' })).timeoutAction).toBe(
      'wait'
    );
  });

  it('accepts timeout seconds at inclusive boundaries', () => {
    expect(parseToolApprovalSettings(JSON.stringify({ timeoutSeconds: 5 })).timeoutSeconds).toBe(5);
    expect(parseToolApprovalSettings(JSON.stringify({ timeoutSeconds: 300 })).timeoutSeconds).toBe(
      300
    );
  });

  it('rejects timeout seconds outside allowed boundaries or non-finite values', () => {
    expect(parseToolApprovalSettings(JSON.stringify({ timeoutSeconds: 4 })).timeoutSeconds).toBe(
      DEFAULT_TOOL_APPROVAL_SETTINGS.timeoutSeconds
    );
    expect(parseToolApprovalSettings(JSON.stringify({ timeoutSeconds: 301 })).timeoutSeconds).toBe(
      DEFAULT_TOOL_APPROVAL_SETTINGS.timeoutSeconds
    );
    expect(
      parseToolApprovalSettings(JSON.stringify({ timeoutSeconds: Number.POSITIVE_INFINITY }))
        .timeoutSeconds
    ).toBe(DEFAULT_TOOL_APPROVAL_SETTINGS.timeoutSeconds);
  });
});
