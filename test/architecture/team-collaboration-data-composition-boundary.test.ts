import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const teamSlicePath = path.join(repoRoot, 'src/renderer/store/slices/teamSlice.ts');
const compositionPath = path.join(
  repoRoot,
  'src/renderer/store/team/createTeamCollaborationDataSlice.ts'
);

const ownedFactories = [
  'createTeamDirectoryRendererSlice',
  'createTeamViewDataRendererSlice',
  'createTeamMessageFeedRendererSlice',
  'createTeamMessageDeliveryRendererSlice',
  'createTeamTaskBoardRendererSlice',
  'createTeamTaskArtifactsRendererSlice',
] as const;

describe('team collaboration data composition boundary', () => {
  it('keeps feature wiring behind one app-store composition entrypoint', () => {
    const teamSliceSource = readFileSync(teamSlicePath, 'utf8');
    const compositionSource = readFileSync(compositionPath, 'utf8');

    expect(teamSliceSource).toContain('createTeamCollaborationDataSlice({');
    for (const factoryName of ownedFactories) {
      expect(teamSliceSource).not.toContain(`${factoryName}(`);
      expect(compositionSource).toContain(`${factoryName}`);
    }
  });

  it('uses composition and narrow ports without AppState casts or facade inheritance', () => {
    const compositionSource = readFileSync(compositionPath, 'utf8');

    expect(compositionSource).not.toContain('as AppState');
    expect(compositionSource).not.toContain('as unknown as AppState');
    expect(compositionSource).not.toContain('extends TeamProvisioning');
    expect(compositionSource).not.toContain('ServiceHost');
    expect(compositionSource).toContain('requestScope: {');
    expect(compositionSource).toContain('lifecycle: {');
    expect(compositionSource).toContain('settings: {');
  });
});
