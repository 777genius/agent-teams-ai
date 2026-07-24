import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const rendererRoot = 'src/features/team-view-read-model/renderer';
const orchestrationPath = `${rendererRoot}/adapters/createTeamDirectoryRendererSlice.ts`;
const transportPath = `${rendererRoot}/adapters/createTeamDirectoryTransport.ts`;
const portsPath = `${rendererRoot}/ports/TeamDirectoryRendererPorts.ts`;
const coordinatorPath = `${rendererRoot}/utils/teamDirectoryRefreshCoordinator.ts`;
const projectionPath = `${rendererRoot}/utils/teamDirectoryProjectionPolicy.ts`;
const publicEntryPath = `${rendererRoot}/index.ts`;
const appShellPath = 'src/renderer/store/slices/teamSlice.ts';

describe('team directory renderer boundary', () => {
  it('keeps orchestration, ports, coordinator, and projection free of transport and store ownership', () => {
    for (const path of [orchestrationPath, portsPath, coordinatorPath, projectionPath]) {
      const contents = source(path);
      expect(contents).not.toMatch(/from ['"]@renderer\//);
      expect(contents).not.toMatch(
        /renderer\/store|window\.electronAPI|ElectronAPI|unwrapIpc|\bapi\.teams\b/
      );
    }
  });

  it('isolates direct renderer API dependencies to the concrete transport', () => {
    const transport = source(transportPath);
    const rendererImports = Array.from(
      transport.matchAll(/from ['"](@renderer\/[^'"]+)['"]/g),
      (match) => match[1]
    );

    expect(rendererImports).toEqual(['@renderer/api', '@renderer/utils/unwrapIpc']);
    expect(transport).not.toMatch(/renderer\/store|window\.electronAPI|ElectronAPI/);
  });

  it('composes through the public entrypoint and removes legacy IPC ownership', () => {
    const publicEntry = source(publicEntryPath);
    const appShell = source(appShellPath);

    expect(publicEntry).toContain('createTeamDirectoryRendererSlice');
    expect(publicEntry).toContain('createTeamDirectoryTransport');
    expect(publicEntry).toContain('TeamDirectoryRefreshCoordinator');
    expect(appShell).toContain("from '@features/team-view-read-model/renderer'");
    expect(appShell).not.toMatch(/team:(?:list|getAllTasks)/);
    expect(appShell).not.toMatch(
      /latestTeamsFetchRequestId|inFlightGlobalTasksRefresh|pendingFreshGlobalTasksRefresh/
    );
  });
});
