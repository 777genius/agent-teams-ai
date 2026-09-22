import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  installTeamRefreshFanoutDebugBridge,
  TEAM_REFRESH_FANOUT_DEBUG_STORAGE_KEY,
} from '../../../src/renderer/store/teamRefreshFanoutDebugBridge';
import {
  __resetTeamRefreshFanoutDiagnosticsForTests,
  noteTeamRefreshFanout,
} from '../../../src/renderer/store/teamRefreshFanoutDiagnostics';

describe('teamRefreshFanoutDebugBridge', () => {
  beforeEach(() => {
    localStorage.clear();
    delete window.__TEAM_REFRESH_FANOUT__;
    __resetTeamRefreshFanoutDiagnosticsForTests();
  });

  afterEach(() => {
    localStorage.clear();
    delete window.__TEAM_REFRESH_FANOUT__;
    __resetTeamRefreshFanoutDiagnosticsForTests();
  });

  it('does not install without the localStorage flag', () => {
    const cleanup = installTeamRefreshFanoutDebugBridge();

    expect(window.__TEAM_REFRESH_FANOUT__).toBeUndefined();
    cleanup();
    expect(window.__TEAM_REFRESH_FANOUT__).toBeUndefined();
  });

  it('installs a frozen bridge behind the localStorage flag', () => {
    localStorage.setItem(TEAM_REFRESH_FANOUT_DEBUG_STORAGE_KEY, '1');

    const cleanup = installTeamRefreshFanoutDebugBridge();

    expect(window.__TEAM_REFRESH_FANOUT__).toBeDefined();
    expect(Object.isFrozen(window.__TEAM_REFRESH_FANOUT__)).toBe(true);
    expect(typeof window.__TEAM_REFRESH_FANOUT__?.snapshot).toBe('function');
    expect(typeof window.__TEAM_REFRESH_FANOUT__?.summary).toBe('function');
    expect(typeof window.__TEAM_REFRESH_FANOUT__?.reset).toBe('function');

    cleanup();
    expect(window.__TEAM_REFRESH_FANOUT__).toBeUndefined();
  });

  it('cleanup removes only the bridge it installed', () => {
    localStorage.setItem(TEAM_REFRESH_FANOUT_DEBUG_STORAGE_KEY, '1');
    const cleanup = installTeamRefreshFanoutDebugBridge();
    const replacement = {
      snapshot: window.__TEAM_REFRESH_FANOUT__!.snapshot,
      summary: window.__TEAM_REFRESH_FANOUT__!.summary,
      reset: window.__TEAM_REFRESH_FANOUT__!.reset,
    };
    window.__TEAM_REFRESH_FANOUT__ = replacement;

    cleanup();

    expect(window.__TEAM_REFRESH_FANOUT__).toBe(replacement);
  });

  it('bridge reset clears diagnostics', () => {
    localStorage.setItem(TEAM_REFRESH_FANOUT_DEBUG_STORAGE_KEY, '1');
    const cleanup = installTeamRefreshFanoutDebugBridge();

    noteTeamRefreshFanout({
      teamName: 'team-a',
      surface: 'team-change-listener',
      phase: 'scheduled',
      reason: 'event:process',
      operation: 'refreshTeamData',
    });

    expect(window.__TEAM_REFRESH_FANOUT__?.summary('team-a').total).toBe(1);
    window.__TEAM_REFRESH_FANOUT__?.reset();
    expect(window.__TEAM_REFRESH_FANOUT__?.summary('team-a').total).toBe(0);

    cleanup();
  });
});
