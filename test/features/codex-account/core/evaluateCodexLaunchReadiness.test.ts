// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { evaluateCodexLaunchReadiness } from '@features/codex-account/core/domain/evaluateCodexLaunchReadiness';

describe('evaluateCodexLaunchReadiness', () => {
  it('prefers a managed ChatGPT account in auto mode when both auth sources are available', () => {
    const readiness = evaluateCodexLaunchReadiness({
      preferredAuthMode: 'auto',
      managedAccount: {
        type: 'chatgpt',
        email: 'user@example.com',
        planType: 'plus',
      },
      apiKey: {
        available: true,
        source: 'stored',
        sourceLabel: 'Stored in app',
      },
      appServerState: 'healthy',
      appServerStatusMessage: null,
    });

    expect(readiness).toEqual({
      state: 'ready_both',
      effectiveAuthMode: 'chatgpt',
      launchAllowed: true,
      issueMessage: null,
    });
  });

  it('blocks launch when ChatGPT account mode is selected but no managed account is connected', () => {
    const readiness = evaluateCodexLaunchReadiness({
      preferredAuthMode: 'chatgpt',
      managedAccount: null,
      apiKey: {
        available: true,
        source: 'environment',
        sourceLabel: 'Detected from OPENAI_API_KEY',
      },
      appServerState: 'healthy',
      appServerStatusMessage: null,
    });

    expect(readiness.state).toBe('missing_auth');
    expect(readiness.effectiveAuthMode).toBeNull();
    expect(readiness.launchAllowed).toBe(false);
    expect(readiness.issueMessage).toContain('Connect a ChatGPT account');
  });

  it('asks for reconnect instead of a fresh login when a locally selected ChatGPT account already exists', () => {
    const readiness = evaluateCodexLaunchReadiness({
      preferredAuthMode: 'chatgpt',
      managedAccount: null,
      apiKey: {
        available: true,
        source: 'environment',
        sourceLabel: 'Detected from OPENAI_API_KEY',
      },
      appServerState: 'healthy',
      appServerStatusMessage: null,
      localActiveChatgptAccountPresent: true,
    });

    expect(readiness.state).toBe('missing_auth');
    expect(readiness.effectiveAuthMode).toBeNull();
    expect(readiness.launchAllowed).toBe(false);
    expect(readiness.issueMessage).toContain('Reconnect ChatGPT');
  });

  it('allows API-key mode when an API key is available', () => {
    const readiness = evaluateCodexLaunchReadiness({
      preferredAuthMode: 'api_key',
      managedAccount: null,
      apiKey: {
        available: true,
        source: 'stored',
        sourceLabel: 'Stored in app',
      },
      appServerState: 'healthy',
      appServerStatusMessage: null,
    });

    expect(readiness).toEqual({
      state: 'ready_api_key',
      effectiveAuthMode: 'api_key',
      launchAllowed: true,
      issueMessage: null,
    });
  });

  it('surfaces degraded-but-launchable state when the managed account is still usable', () => {
    const readiness = evaluateCodexLaunchReadiness({
      preferredAuthMode: 'auto',
      managedAccount: {
        type: 'chatgpt',
        email: 'user@example.com',
        planType: 'pro',
      },
      apiKey: {
        available: false,
        source: null,
        sourceLabel: null,
      },
      appServerState: 'degraded',
      appServerStatusMessage: 'Temporary app-server probe failure',
    });

    expect(readiness).toEqual({
      state: 'warning_degraded_but_launchable',
      effectiveAuthMode: 'chatgpt',
      launchAllowed: true,
      issueMessage: 'Temporary app-server probe failure',
    });
  });

  it('fails fast when the Codex runtime is missing entirely', () => {
    const readiness = evaluateCodexLaunchReadiness({
      preferredAuthMode: 'auto',
      managedAccount: null,
      apiKey: {
        available: true,
        source: 'stored',
        sourceLabel: 'Stored in app',
      },
      appServerState: 'runtime-missing',
      appServerStatusMessage: 'Codex CLI not found',
    });

    expect(readiness).toEqual({
      state: 'runtime_missing',
      effectiveAuthMode: null,
      launchAllowed: false,
      issueMessage: 'Codex CLI not found',
    });
  });
});
