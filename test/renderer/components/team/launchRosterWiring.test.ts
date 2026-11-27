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

/** Every relaunch call, retaining its position so the project early return is checked. */
function relaunchCalls(source: string): { start: number; text: string }[] {
  return [...source.matchAll(/executeTeamRelaunch\(\{/g)].map((match) => {
    const start = match.index;
    const end = source.indexOf('launchTeam,\n', start);
    if (end < 0) throw new Error('Relaunch call must retain its launchTeam port');
    return { start, text: source.slice(start, end + 'launchTeam,'.length) };
  });
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
    const calls = relaunchCalls(handler);
    expect(calls).toHaveLength(2);
    const [project, shared] = calls;
    expect(handler.indexOf('if (logicalTeamName) {')).toBeGreaterThanOrEqual(0);
    expect(handler.indexOf('if (logicalTeamName) {')).toBeLessThan(project.start);
    expect(project.text).toContain('teamName: logicalTeamName');
    expect(project.text).toContain(
      'request: toLogicalProjectLaunchRequest(request, logicalTeamName)'
    );
    expect(project.text).toContain('rosterReadOnly: true');
    expect(handler.slice(project.start + project.text.length, shared.start)).toMatch(
      /^\s*\}\);\s*return;\s*\}\s*await\s*$/
    );
    expect(shared.text).toContain('teamName,');
    expect(shared.text).toContain('request,');
    expect(shared.text).toContain('rosterReadOnly: false');
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
    const calls = relaunchCalls(source);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain(
      'rosterReadOnly: launchDialogProjectPermissionTeamName !== undefined'
    );
  });

  it('ProjectScopedTeamDetailView marks the roster of its launch dialog read-only', () => {
    const dialogs = launchDialogElements(read('ProjectScopedTeamDetailView.tsx'));
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toContain('rosterReadOnly');
  });
});
