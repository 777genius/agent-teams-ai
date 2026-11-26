import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * TeamDetailView and TeamListView are too large to render in a unit test, so
 * the wiring that keeps launch and relaunch dialogs from writing the roster of
 * a per-project team is pinned structurally here. The behavior behind it is
 * covered by teamRelaunchFlow, launchRosterPersistence and
 * buildChangeRuntimeLaunchState tests; the types make `rosterReadOnly` a
 * required option of the relaunch flow, so no caller can omit it.
 */
const root = path.resolve(__dirname, '../../../../src/renderer/components/team');
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');

/** Text of every `<LaunchTeamDialog ... />` element opening of a file. */
function launchDialogElements(source: string): string[] {
  const elements: string[] = [];
  for (const match of source.matchAll(/<LaunchTeamDialog\b/g)) {
    const start = match.index ?? 0;
    elements.push(source.slice(start, source.indexOf('/>', start)));
  }
  return elements;
}

/** Text of the options passed to the first `executeTeamRelaunch({ ... })` call. */
function relaunchCall(source: string): string {
  const start = source.indexOf('executeTeamRelaunch({');
  return source.slice(start, source.indexOf('launchTeam,\n', start));
}

describe('launch dialog wiring of per-project teams', () => {
  it('TeamDetailView marks the roster read-only for a per-project team and builds the change-runtime state with the helper', () => {
    const source = read('TeamDetailView.tsx');
    const dialogs = launchDialogElements(source);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toContain('rosterReadOnly={Boolean(logicalTeamName)}');
    const changeRuntime = source.slice(
      source.indexOf('const handleChangeLeadRuntime ='),
      source.indexOf('const memberActions =')
    );
    expect(changeRuntime).toMatch(/const next = buildChangeRuntimeLaunchState\(\{/);
    // The owned opener preserves retained-team selection and the complete settings intent.
    const launchSettings = changeRuntime.match(
      /openLaunchDialog\(\s*next\.mode,\s*\{([\s\S]*?)\}\s*\)/
    )?.[1];
    expect(launchSettings).toBeDefined();
    for (const field of ['memberSettingsDraft', 'baselineMembers', 'memberSettingsCommandId']) {
      expect(launchSettings).toMatch(new RegExp(`\\b${field}:\\s*next\\.${field}\\b`));
    }
    expect(changeRuntime).not.toContain('setLaunchDialogState(');
    // A per-project relaunch returns before the shared relaunch flow, which is for ordinary teams.
    const handler = source.slice(source.indexOf('const handleRelaunchDialogSubmit'));
    expect(handler.indexOf('if (logicalTeamName) {')).toBeLessThan(
      handler.indexOf('executeTeamRelaunch({')
    );
    expect(relaunchCall(source)).toContain('rosterReadOnly: false');
  });

  it('TeamListView marks the roster read-only for both modes and for the relaunch flow when it runs a project copy', () => {
    const source = read('TeamListView.tsx');
    const dialogs = launchDialogElements(source);
    expect(dialogs).toHaveLength(2);
    for (const dialog of dialogs) {
      expect(dialog).toContain(
        'rosterReadOnly={launchDialogProjectPermissionTeamName !== undefined}'
      );
    }
    expect(relaunchCall(source)).toContain(
      'rosterReadOnly: launchDialogProjectPermissionTeamName !== undefined'
    );
  });

  it('ProjectScopedTeamDetailView marks the roster of its launch dialog read-only', () => {
    const dialogs = launchDialogElements(read('ProjectScopedTeamDetailView.tsx'));
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toContain('rosterReadOnly');
  });
});
