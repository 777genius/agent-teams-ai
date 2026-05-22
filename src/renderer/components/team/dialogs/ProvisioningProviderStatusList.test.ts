import { OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE } from '@shared/utils/openCodeWindowsAccessDenied';
import { describe, expect, it } from 'vitest';

import { getProvisioningFailureHint } from './ProvisioningProviderStatusList';

describe('getProvisioningFailureHint', () => {
  it('returns the OpenCode Windows permissions hint for OpenCode access-denied details', () => {
    expect(
      getProvisioningFailureHint(null, [
        {
          providerId: 'opencode',
          status: 'failed',
          details: [OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE],
        },
      ])
    ).toBe(
      'Fix folder permissions or move the project to a user-writable folder. Running as administrator is only a temporary workaround.'
    );
  });

  it('keeps non-OpenCode access-denied details on the generic CLI hint', () => {
    expect(
      getProvisioningFailureHint(null, [
        {
          providerId: 'anthropic',
          status: 'failed',
          details: ['EACCES: permission denied'],
        },
      ])
    ).toBe(
      'Make sure the local Claude CLI binary exists and can be started, then reopen this dialog.'
    );
  });

  it('does not treat a mixed-provider generic access-denied message as OpenCode-specific', () => {
    expect(
      getProvisioningFailureHint('EACCES: permission denied', [
        {
          providerId: 'opencode',
          status: 'ready',
          details: [],
        },
        {
          providerId: 'anthropic',
          status: 'failed',
          details: ['EACCES: permission denied'],
        },
      ])
    ).toBe(
      'Make sure the local Claude CLI binary exists and can be started, then reopen this dialog.'
    );
  });

  it('does not prefer OpenCode access-denied notes over another provider failure', () => {
    expect(
      getProvisioningFailureHint(null, [
        {
          providerId: 'opencode',
          status: 'notes',
          details: [OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE],
        },
        {
          providerId: 'anthropic',
          status: 'failed',
          details: ['EACCES: permission denied'],
        },
      ])
    ).toBe(
      'Make sure the local Claude CLI binary exists and can be started, then reopen this dialog.'
    );
  });

  it('uses a normalized OpenCode access-denied message for a failed mixed-provider check', () => {
    expect(
      getProvisioningFailureHint(OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE, [
        {
          providerId: 'opencode',
          status: 'failed',
          details: [],
        },
        {
          providerId: 'anthropic',
          status: 'ready',
          details: [],
        },
      ])
    ).toBe(
      'Fix folder permissions or move the project to a user-writable folder. Running as administrator is only a temporary workaround.'
    );
  });

  it('uses a raw OpenCode access-denied message when no other provider failed', () => {
    expect(
      getProvisioningFailureHint('EPERM: operation not permitted', [
        {
          providerId: 'opencode',
          status: 'failed',
          details: [],
        },
        {
          providerId: 'anthropic',
          status: 'ready',
          details: [],
        },
      ])
    ).toBe(
      'Fix folder permissions or move the project to a user-writable folder. Running as administrator is only a temporary workaround.'
    );
  });

  it('uses the OpenCode Windows permissions hint for a single OpenCode access-denied message', () => {
    expect(
      getProvisioningFailureHint('EPERM: operation not permitted', [
        {
          providerId: 'opencode',
          status: 'failed',
          details: [],
        },
      ])
    ).toBe(
      'Fix folder permissions or move the project to a user-writable folder. Running as administrator is only a temporary workaround.'
    );
  });

  it('keeps existing OpenCode runtime missing and MCP hints unchanged', () => {
    expect(
      getProvisioningFailureHint(null, [
        {
          providerId: 'opencode',
          status: 'failed',
          details: [
            'OpenCode runtime binary is not installed or not reachable by launch preflight.',
          ],
        },
      ])
    ).toBe(
      'Install or retry OpenCode runtime from the provider status card, then reopen this dialog.'
    );

    expect(
      getProvisioningFailureHint(null, [
        {
          providerId: 'opencode',
          status: 'failed',
          details: ['OpenCode app MCP is unreachable. Retry launch to refresh the app MCP bridge.'],
        },
      ])
    ).toBe(
      'Retry launch to refresh the OpenCode app MCP bridge. If it repeats, restart the app and OpenCode runtime.'
    );
  });
});
