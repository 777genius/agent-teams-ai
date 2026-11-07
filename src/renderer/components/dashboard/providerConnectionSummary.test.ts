import { describe, expect, it } from 'vitest';

import { getDashboardConnectionSummary } from './providerConnectionSummary';

const revision = JSON.stringify(['ready', '1.2.3', '/bin/opencode']);
const runtimeStatus = {
  installed: true,
  state: 'ready' as const,
  version: '1.2.3',
  binaryPath: '/bin/opencode',
};
const baseCliStatus = {
  installed: true,
  flavor: 'agent_teams_orchestrator',
  providers: [
    { providerId: 'anthropic' as const, authenticated: true, verificationState: 'verified' as const, statusCheckOutcome: 'authoritative' as const },
    { providerId: 'codex' as const, authenticated: false, verificationState: 'verified' as const, statusCheckOutcome: 'authoritative' as const },
    { providerId: 'gemini' as const, authenticated: true, verificationState: 'verified' as const, statusCheckOutcome: 'authoritative' as const },
    { providerId: 'opencode' as const, authenticated: true, verificationState: 'verified' as const, statusCheckOutcome: 'authoritative' as const },
  ],
};
const globalDirectory = {
  entries: [
    { providerId: 'openrouter', state: 'connected' as const },
    { providerId: 'xai', state: 'connected' as const },
    { providerId: 'ollama', state: 'available' as const },
  ],
  authoritative: true,
  runtimeRevision: revision,
  fetchedAt: new Date().toISOString(),
  totalCount: 3,
  nextCursor: null,
};
const input = {
  cliStatus: baseCliStatus,
  cliStatusLoading: false,
  providerStatusLoading: {},
  projectPath: null,
  globalDirectory,
  projectDirectory: null,
  runtimeStatus,
};

describe('getDashboardConnectionSummary (no IPC)', () => {
  it('counts verified CLI logins separately from complete OpenCode directory connections', () => {
    expect(getDashboardConnectionSummary(input)).toEqual({ cliConnected: 2, cliCountComplete: true, openCodeConnected: 2 });
  });

  it('never counts an OpenCode host or inventory-only fallback as a separate CLI credential', () => {
    const cliStatus = {
      ...baseCliStatus,
      providers: baseCliStatus.providers.map((provider) =>
        provider.providerId === 'anthropic' ? { ...provider, authenticated: false } : provider
      ),
    };
    expect(getDashboardConnectionSummary({ ...input, cliStatus })).toEqual({
      cliConnected: 1,
      cliCountComplete: true,
      openCodeConnected: 2,
    });
  });

  it('does not present zero as a verified count during startup or transient failures', () => {
    expect(getDashboardConnectionSummary({ ...input, cliStatus: null })).toEqual({
      cliConnected: null,
      cliCountComplete: false,
      openCodeConnected: 2,
    });
    const cliStatus = {
      ...baseCliStatus,
      providers: baseCliStatus.providers.map((provider) =>
        provider.providerId === 'codex'
          ? { ...provider, statusCheckOutcome: 'transient_error' as const }
          : provider
      ),
    };
    expect(getDashboardConnectionSummary({ ...input, cliStatus })).toMatchObject({
      cliConnected: 2,
      cliCountComplete: false,
    });
    expect(getDashboardConnectionSummary({ ...input, cliStatusLoading: true }).cliCountComplete).toBe(false);
  });

  it('does not claim an exact OpenCode count for partial, absent or stale directories', () => {
    expect(getDashboardConnectionSummary({ ...input, globalDirectory: null }).openCodeConnected).toBeNull();
    expect(getDashboardConnectionSummary({
      ...input,
      globalDirectory: { ...globalDirectory, authoritative: false },
    }).openCodeConnected).toBeNull();
    expect(getDashboardConnectionSummary({
      ...input,
      globalDirectory: { ...globalDirectory, nextCursor: 'next' },
    }).openCodeConnected).toBeNull();
    expect(getDashboardConnectionSummary({
      ...input,
      globalDirectory: { ...globalDirectory, totalCount: 100 },
    }).openCodeConnected).toBeNull();
    expect(getDashboardConnectionSummary({
      ...input,
      globalDirectory: { ...globalDirectory, runtimeRevision: 'replaced' },
    }).openCodeConnected).toBeNull();
    expect(getDashboardConnectionSummary({
      ...input,
      runtimeStatus: { ...runtimeStatus, state: 'checking' as const },
    }).openCodeConnected).toBeNull();
  });

  it('requires both complete global and project snapshots before reporting a project count', () => {
    const projectDirectory = {
      ...globalDirectory,
      entries: [
        { providerId: 'openrouter', state: 'available' as const },
        { providerId: 'private-project-provider', state: 'connected' as const },
      ],
      totalCount: 2,
    };
    expect(getDashboardConnectionSummary({
      ...input,
      projectPath: '/work/project',
      projectDirectory: null,
    }).openCodeConnected).toBeNull();
    expect(getDashboardConnectionSummary({
      ...input,
      projectPath: '/work/project',
      projectDirectory,
    }).openCodeConnected).toBe(2); // xai (global), private project; openrouter overridden
  });

  it('expires cached OpenCode observations without treating stale counts as live', () => {
    const nowMs = Date.parse('2026-11-07T12:00:00Z');
    expect(getDashboardConnectionSummary({
      ...input,
      globalDirectory: { ...globalDirectory, fetchedAt: new Date(nowMs - 119_000).toISOString() },
      nowMs,
    }).openCodeConnected).toBe(2);
    expect(getDashboardConnectionSummary({
      ...input,
      globalDirectory: { ...globalDirectory, fetchedAt: new Date(nowMs - 121_000).toISOString() },
      nowMs,
    }).openCodeConnected).toBeNull();
    expect(getDashboardConnectionSummary({
      ...input,
      globalDirectory: { ...globalDirectory, fetchedAt: 'invalid' },
      nowMs,
    }).openCodeConnected).toBeNull();
  });

  it('does not claim an exact count when one cached directory entry has unresolved status', () => {
    expect(getDashboardConnectionSummary({
      ...input,
      globalDirectory: {
        ...globalDirectory,
        entries: [
          { providerId: 'openrouter', state: 'error' as const },
          ...globalDirectory.entries.slice(1),
        ],
      },
    }).openCodeConnected).toBeNull();
  });

  it('deduplicates case-folded OpenCode ids and excludes the OpenCode host entry', () => {
    expect(getDashboardConnectionSummary({
      ...input,
      globalDirectory: {
        ...globalDirectory,
        entries: [
          { providerId: 'OpenRouter', state: 'connected' as const },
          { providerId: 'openrouter', state: 'connected' as const },
          { providerId: 'opencode', state: 'connected' as const },
        ],
      },
    }).openCodeConnected).toBe(1);
  });
});
