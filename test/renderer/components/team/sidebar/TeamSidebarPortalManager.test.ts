import { afterEach, describe, expect, it } from 'vitest';

import {
  getTeamSidebarPortalSnapshotForTests,
  resetTeamSidebarPortalManagerForTests,
  upsertTeamSidebarHost,
  upsertTeamSidebarSource,
} from '@renderer/components/team/sidebar/TeamSidebarPortalManager';

afterEach(() => {
  resetTeamSidebarPortalManagerForTests();
});

describe('TeamSidebarPortalManager', () => {
  it('prefers overlay host over graph tab and team hosts for the same team', () => {
    upsertTeamSidebarHost('team-host', {
      teamName: 'alpha',
      surface: 'team',
      element: document.createElement('div'),
      isActive: true,
      isFocused: true,
    });
    upsertTeamSidebarHost('graph-host', {
      teamName: 'alpha',
      surface: 'graph-tab',
      element: document.createElement('div'),
      isActive: true,
      isFocused: false,
    });
    upsertTeamSidebarHost('overlay-host', {
      teamName: 'alpha',
      surface: 'graph-overlay',
      element: document.createElement('div'),
      isActive: true,
      isFocused: true,
    });

    const snapshot = getTeamSidebarPortalSnapshotForTests();

    expect(snapshot.activeHostIdByTeam.alpha).toBe('overlay-host');
  });

  it('prefers the active team host over an inactive graph host', () => {
    upsertTeamSidebarHost('team-host', {
      teamName: 'alpha',
      surface: 'team',
      element: document.createElement('div'),
      isActive: true,
      isFocused: true,
    });
    upsertTeamSidebarHost('graph-host', {
      teamName: 'alpha',
      surface: 'graph-tab',
      element: document.createElement('div'),
      isActive: false,
      isFocused: false,
    });

    const snapshot = getTeamSidebarPortalSnapshotForTests();

    expect(snapshot.activeHostIdByTeam.alpha).toBe('team-host');
  });

  it('prefers focused graph host over unfocused graph host of the same priority', () => {
    upsertTeamSidebarHost('graph-a', {
      teamName: 'alpha',
      surface: 'graph-tab',
      element: document.createElement('div'),
      isActive: true,
      isFocused: false,
    });
    upsertTeamSidebarHost('graph-b', {
      teamName: 'alpha',
      surface: 'graph-tab',
      element: document.createElement('div'),
      isActive: true,
      isFocused: true,
    });

    const snapshot = getTeamSidebarPortalSnapshotForTests();

    expect(snapshot.activeHostIdByTeam.alpha).toBe('graph-b');
  });

  it('prefers focused active source over stale mounted source for the same team', () => {
    upsertTeamSidebarSource('source-a', {
      teamName: 'alpha',
      isActive: true,
      isFocused: false,
    });
    upsertTeamSidebarSource('source-b', {
      teamName: 'alpha',
      isActive: true,
      isFocused: true,
    });

    const snapshot = getTeamSidebarPortalSnapshotForTests();

    expect(snapshot.activeSourceIdByTeam.alpha).toBe('source-b');
  });
});
