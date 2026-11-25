// @vitest-environment node
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { eagerChain, sourceGraph, sourceRoot as root } from '../../../helpers/sourceModuleGraph';

const entry = 'src/renderer/main.tsx';
const pane = 'src/renderer/components/layout/PaneContent.tsx';
const dashboard = 'src/renderer/components/dashboard/DashboardView.tsx';
const settings = 'src/renderer/components/settings/SettingsView.tsx';
const settingsContent = 'src/renderer/components/settings/SettingsContent.tsx';
const routes = [
  {
    name: 'Dashboard',
    view: dashboard,
    complete: [
      'src/features/recent-projects/renderer/ui/RecentProjectsSection.tsx',
      'src/features/running-teams/renderer/ui/RunningTeamsSection.tsx',
      'src/features/runtime-provider-management/renderer/RuntimeProviderManagementPanel.tsx',
      'src/features/runtime-provider-management/renderer/RuntimeProviderOnboardingDialog.tsx',
      'src/features/runtime-provider-management/renderer/RuntimeProviderQuickConnect.tsx',
    ],
  },
  {
    name: 'Settings',
    view: settings,
    complete: [
      'src/renderer/components/settings/SettingsTabs.tsx',
      'src/renderer/components/settings/SettingsLoadingSkeleton.tsx',
    ],
  },
];

describe('Pane renderer load boundaries', () => {
  const eager = sourceGraph(entry);

  it.each(routes)(
    'defers the $name route and its dedicated UI until activation',
    ({ view, complete }) => {
      const reached = [view, ...complete].filter((file) =>
        eager.parents.has(path.resolve(root, file))
      );
      expect(
        reached,
        reached.map((file) => eagerChain(eager.parents, path.resolve(root, file))).join('\n')
      ).toEqual([]);
    }
  );

  it('keeps pane contexts, the sidebar and the TaskDetail shell in the initial graph', () => {
    const shell = [
      'src/renderer/contexts/TabUIContext.tsx',
      'src/renderer/components/layout/Sidebar.tsx',
      'src/features/team-task-detail/renderer/shell/index.ts',
      'src/features/localization/renderer/index.ts',
      'src/renderer/store/index.ts',
    ];
    expect(shell.filter((file) => !eager.parents.has(path.resolve(root, file)))).toEqual([]);
  });

  it.each(routes)('retains the complete $name view behind the pane route', ({ view, complete }) => {
    expect(eager.deferred).toContainEqual({
      from: path.resolve(root, pane),
      to: path.resolve(root, view),
    });
    const opened = sourceGraph(view);
    expect(complete.filter((file) => !opened.parents.has(path.resolve(root, file)))).toEqual([]);
  });

  it('retains the existing Settings shell route to its complete content', () => {
    const opened = sourceGraph(settings);
    expect(opened.deferred).toContainEqual({
      from: path.resolve(root, settings),
      to: path.resolve(root, settingsContent),
    });
    const content = sourceGraph(settingsContent);
    expect(
      content.parents.has(
        path.resolve(
          root,
          'src/features/runtime-provider-management/renderer/RuntimeProviderManagementPanel.tsx'
        )
      )
    ).toBe(true);
  });
});
