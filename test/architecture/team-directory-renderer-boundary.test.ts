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
const delegationShellPath = 'src/renderer/store/slices/teamSlice.ts';
const compositionPath = 'src/renderer/store/team/createTeamStoreFeatureSlices.ts';

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
    const delegationShell = source(delegationShellPath);
    const composition = source(compositionPath);

    expect(publicEntry).toContain('createTeamDirectoryRendererSlice');
    expect(publicEntry).toContain('createTeamDirectoryTransport');
    expect(publicEntry).toContain('TeamDirectoryRefreshCoordinator');
    expect(delegationShell).toContain("from '../team/createTeamStoreFeatureSlices'");
    expect(delegationShell).not.toContain("from '@features/team-view-read-model/renderer'");
    expect(composition).toContain("from '@features/team-view-read-model/renderer'");
    expect(composition).not.toMatch(/@features\/team-view-read-model\/renderer\//);
    expect(`${delegationShell}\n${composition}`).not.toMatch(/team:(?:list|getAllTasks)/);
    expect(`${delegationShell}\n${composition}`).not.toMatch(
      /latestTeamsFetchRequestId|inFlightGlobalTasksRefresh|pendingFreshGlobalTasksRefresh/
    );
  });
});
