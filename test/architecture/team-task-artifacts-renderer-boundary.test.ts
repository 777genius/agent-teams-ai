import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const orchestrationPath =
  'src/features/team-task-board/renderer/adapters/createTeamTaskArtifactsRendererSlice.ts';
const transportPath =
  'src/features/team-task-board/renderer/adapters/createTeamTaskArtifactsTransport.ts';
const projectionPolicyPath =
  'src/features/team-task-board/renderer/adapters/taskChangePresenceProjectionPolicy.ts';
const publicEntryPath = 'src/features/team-task-board/renderer/index.ts';
const appShellPath = 'src/renderer/store/slices/teamSlice.ts';

describe('team task artifacts renderer boundary', () => {
  it('keeps orchestration independent from renderer transport and store internals', () => {
    const orchestration = source(orchestrationPath);

    expect(orchestration).not.toMatch(/from ['"]@renderer\//);
    expect(orchestration).not.toMatch(/renderer\/store|window\.electronAPI|ElectronAPI/);
    expect(orchestration).not.toMatch(/\bapi\.(?:teams|review)\b|unwrapIpc/);
  });

  it('keeps direct IPC dependencies isolated to the concrete transport edge', () => {
    const transport = source(transportPath);
    const rendererImports = Array.from(
      transport.matchAll(/from ['"](@renderer\/[^'"]+)['"]/g),
      (match) => match[1]
    );

    expect(rendererImports).toEqual(['@renderer/api', '@renderer/utils/unwrapIpc']);
    expect(transport).not.toMatch(/renderer\/store|window\.electronAPI|ElectronAPI/);
  });

  it('keeps change-presence projection free of store and transport ownership', () => {
    const projectionPolicy = source(projectionPolicyPath);

    expect(projectionPolicy).not.toMatch(
      /renderer\/store|window\.electronAPI|ElectronAPI|unwrapIpc|\bapi\.(?:teams|review)\b/
    );
  });

  it('composes through the feature public entrypoint and removes legacy IPC ownership', () => {
    const publicEntry = source(publicEntryPath);
    const appShell = source(appShellPath);

    expect(publicEntry).toContain('createTeamTaskArtifactsRendererSlice');
    expect(publicEntry).toContain('createTeamTaskArtifactsTransport');
    expect(appShell).toContain("from '@features/team-task-board/renderer'");
    expect(appShell).not.toMatch(
      /team:(?:getTaskChangePresence|saveTaskAttachment|deleteTaskAttachment|getTaskAttachment|addTaskComment)/
    );
  });
});
