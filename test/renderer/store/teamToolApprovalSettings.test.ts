import { beforeEach, describe, expect, it } from 'vitest';

import {
  loadAllToolApprovalSettingsByTeam,
  loadLegacyToolApprovalSettings,
  loadToolApprovalSettingsForTeam,
  parseToolApprovalSettings,
  resolveToolApprovalSettingsForTeam,
  saveLegacyToolApprovalSettings,
  saveToolApprovalSettingsForTeam,
} from '../../../src/renderer/store/team/teamToolApprovalSettings';
import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '../../../src/shared/types/team';

describe('teamToolApprovalSettings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

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

  it('persists and loads settings independently for each team', () => {
    const alpha = { ...DEFAULT_TOOL_APPROVAL_SETTINGS, autoAllowAll: true };
    const beta = { ...DEFAULT_TOOL_APPROVAL_SETTINGS, autoAllowSafeBash: true };

    saveToolApprovalSettingsForTeam('alpha', alpha);
    saveToolApprovalSettingsForTeam('beta', beta);

    expect(loadToolApprovalSettingsForTeam('alpha')).toEqual(alpha);
    expect(loadToolApprovalSettingsForTeam('beta')).toEqual(beta);
  });

  it('keeps the legacy no-team fallback separate from per-team settings', () => {
    const legacy = { ...DEFAULT_TOOL_APPROVAL_SETTINGS, timeoutAction: 'deny' as const };
    const alpha = { ...DEFAULT_TOOL_APPROVAL_SETTINGS, autoAllowAll: true };

    saveLegacyToolApprovalSettings(legacy);
    saveToolApprovalSettingsForTeam('alpha', alpha);

    expect(loadLegacyToolApprovalSettings()).toEqual(legacy);
    expect(loadToolApprovalSettingsForTeam('alpha')).toEqual(alpha);
    expect(loadToolApprovalSettingsForTeam('missing')).toBe(DEFAULT_TOOL_APPROVAL_SETTINGS);
  });

  it('rehydrates every persisted team without treating the legacy key as a team', () => {
    const alpha = { ...DEFAULT_TOOL_APPROVAL_SETTINGS, autoAllowAll: true };
    const beta = { ...DEFAULT_TOOL_APPROVAL_SETTINGS, autoAllowFileEdits: true };
    saveLegacyToolApprovalSettings({ ...DEFAULT_TOOL_APPROVAL_SETTINGS, autoAllowSafeBash: true });
    saveToolApprovalSettingsForTeam('alpha', alpha);
    saveToolApprovalSettingsForTeam('beta', beta);

    expect(loadAllToolApprovalSettingsByTeam()).toEqual({ alpha, beta });
  });

  it('resolves settings for the approval team instead of the selected team', () => {
    const selected = { ...DEFAULT_TOOL_APPROVAL_SETTINGS, timeoutAction: 'wait' as const };
    const background = {
      ...DEFAULT_TOOL_APPROVAL_SETTINGS,
      timeoutAction: 'deny' as const,
      timeoutSeconds: 45,
    };

    expect(resolveToolApprovalSettingsForTeam({ background }, selected, 'background')).toBe(
      background
    );
    expect(resolveToolApprovalSettingsForTeam({ background }, selected)).toBe(selected);
  });
});
