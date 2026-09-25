import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');
const sourceFilesUnder = (path: string): string[] =>
  readdirSync(join(process.cwd(), path), { withFileTypes: true }).flatMap((entry) => {
    const childPath = `${path}/${entry.name}`;
    if (entry.isDirectory()) return sourceFilesUnder(childPath);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [childPath] : [];
  });

const storePath = 'src/renderer/store/index.ts';
const outerTransportPath = 'src/renderer/composition/team/createTeamStoreEventTransport.ts';

describe('team renderer store event transport boundary', () => {
  it('routes the legacy store through one outer provider-neutral transport', () => {
    const store = source(storePath);
    const factoryDeclaration =
      /\bexport function createTeamStoreEventTransport\s*\(\s*\)\s*:\s*TeamStoreEventTransport/;
    const factoryReference = /\bcreateTeamStoreEventTransport\b/;

    expect(source(outerTransportPath), outerTransportPath).toMatch(factoryDeclaration);
    expect(sourceFilesUnder('src').filter((path) => factoryDeclaration.test(source(path)))).toEqual(
      [outerTransportPath]
    );
    expect(store, storePath).toContain(
      "from '@renderer/composition/team/createTeamStoreEventTransport'"
    );
    expect(store, storePath).toContain('const teamEvents = createTeamStoreEventTransport();');
    expect(
      sourceFilesUnder('src/renderer/store').filter((path) => factoryReference.test(source(path)))
    ).toEqual([storePath]);
    expect(store, storePath).not.toMatch(/\bapi\.teams\b|window\.electronAPI\.teams/);
  });

  it('limits the concrete API wrapper to the six admitted event capabilities', () => {
    const transport = source(outerTransportPath);
    const wrappedTeamCapabilities = [...transport.matchAll(/\bteams\?\.(\w+)/g)].map(
      (match) => match[1]
    );

    expect([...new Set(wrappedTeamCapabilities)].sort()).toEqual([
      'onProjectBranchChange',
      'onTeamChange',
      'onToolApprovalEvent',
      'setChangePresenceTracking',
      'setTaskLogStreamTracking',
      'setToolActivityTracking',
    ]);
    expect(transport, outerTransportPath).toContain("from '@renderer/api'");
    expect(transport, outerTransportPath).toContain('const teams = api.teams;');
    expect(transport, outerTransportPath).not.toMatch(
      /window\.electronAPI|ElectronAPI|ipcRenderer|lifecycle|killProcess|launchTeam|stopRegisteredProcess|OpenCode|opencode/
    );
  });

  it('keeps throttling, refresh, timers, projections, and orchestration in the store', () => {
    const store = source(storePath);
    const transport = source(outerTransportPath);
    const storeOwnedPolicy = [
      'TEAM_REFRESH_THROTTLE_MS',
      'teamRefreshTimers',
      'refreshTeamData',
      'normalizePath(event.projectPath)',
      'pendingApprovals',
      'useStore.subscribe',
      'setTimeout',
      'setInterval',
    ] as const;

    for (const fragment of storeOwnedPolicy) {
      expect(store, storePath).toContain(fragment);
      expect(transport, outerTransportPath).not.toContain(fragment);
    }
    expect(transport, outerTransportPath).not.toMatch(
      /\b(?:catch|clearTimeout|clearInterval|Promise\.all|zustand)\b/
    );
  });
});
