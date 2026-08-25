import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const hookPath = 'src/renderer/hooks/useBranchSync.ts';
const portPath =
  'src/features/team-view-read-model/renderer/ports/TeamBranchTrackingRendererPorts.ts';
const coordinatorPath =
  'src/features/team-view-read-model/renderer/utils/TeamBranchTrackingCoordinator.ts';
const publicEntryPath = 'src/features/team-view-read-model/renderer/index.ts';
const transportPath = 'src/renderer/composition/team/createTeamBranchTrackingTransport.ts';
const storePath = 'src/renderer/store/index.ts';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('team branch tracking renderer boundary', () => {
  it('ratchets the hook to zero direct team or Electron API access', () => {
    const hook = source(hookPath);

    expect(hook).not.toMatch(/\bapi\.teams\b|window\.electronAPI\.teams|@renderer\/api/);
    expect(hook).toContain("from '@features/team-view-read-model/renderer'");
    expect(hook).toContain("from '@renderer/composition/team/createTeamBranchTrackingTransport'");
    expect(hook).not.toMatch(
      /@features\/team-view-read-model\/renderer\/(?:ports|utils|adapters|composition)\//
    );
  });

  it('keeps the feature port to one neutral tracking capability', () => {
    const port = source(portPath);

    expect(port).toContain('export interface TeamBranchTrackingRendererPorts');
    expect(port).toContain('setTracking(projectPath: string, enabled: boolean): Promise<void>');
    expect(port.match(/\w+\([^)]*\):\s*Promise<void>/g) ?? []).toHaveLength(1);
    expect(port).not.toMatch(
      /@renderer\/|Electron|window\.|api\.|provider|runtime|process|lifecycle|OpenCode|opencode|Claude|child_process|renderer\/store/i
    );
  });

  it('confines the legacy API mapping to the outer renderer transport', () => {
    const boundaryPaths = [hookPath, portPath, coordinatorPath, publicEntryPath, transportPath];
    const sourcesByPath = Object.fromEntries(boundaryPaths.map((path) => [path, source(path)]));
    const transport = sourcesByPath[transportPath];

    expect(transport).toContain("import { api } from '@renderer/api'");
    expect(transport).toContain('api.teams.setProjectBranchTracking(projectPath, enabled)');
    expect(transport.match(/\bapi\.teams\b/g) ?? []).toHaveLength(1);
    expect(
      Object.entries(sourcesByPath)
        .filter(([, contents]) => contents.includes('setProjectBranchTracking'))
        .map(([path]) => path)
    ).toEqual([transportPath]);
    expect(transport).not.toMatch(
      /window\.electronAPI|renderer\/store|child_process|poll|provider|runtime|process|lifecycle/i
    );
  });

  it('keeps refcount and path-set coordination feature-owned without a broader owner', () => {
    const coordinator = source(coordinatorPath);

    expect(coordinator).toContain('export class TeamBranchTrackingCoordinator');
    expect(coordinator).toContain('private readonly trackedPaths = new Map');
    expect(coordinator).toContain('current.refCount += 1');
    expect(coordinator).toContain('this.requestTracking(projectPath, true)');
    expect(coordinator).toContain('this.requestTracking(current.projectPath, false)');
    expect(coordinator).not.toMatch(
      /@renderer\/|Electron|window\.|api\.|OpenCode|opencode|Claude|child_process|renderer\/store|setInterval|setTimeout|poll|provider|runtime|process|lifecycle/i
    );
  });

  it('exports the port and coordinator through the feature renderer entrypoint', () => {
    const publicEntry = source(publicEntryPath);

    expect(publicEntry).toContain('TeamBranchTrackingRendererPorts');
    expect(publicEntry).toContain('TeamBranchTrackingCoordinator');
    expect(publicEntry).toContain('TeamBranchTrackingRegistration');
  });

  it('preserves initial branch fetches and the existing project-branch event owner', () => {
    const hook = source(hookPath);
    const store = source(storePath);
    const coordinator = source(coordinatorPath);
    const transport = source(transportPath);

    expect(hook).toContain('void fetchBranches(pathEntries.map');
    expect(store).toContain(
      'const subscribeToProjectBranchChanges = teamEvents.subscribeToProjectBranchChanges;'
    );
    expect(store).toContain('const normalizedPath = normalizePath(event.projectPath);');
    expect([hook, coordinator, transport].join('\n')).not.toContain(
      'subscribeToProjectBranchChanges'
    );
  });
});
