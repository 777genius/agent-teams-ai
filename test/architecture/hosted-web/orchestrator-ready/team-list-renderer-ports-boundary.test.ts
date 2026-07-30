import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const detailViewPath = 'src/renderer/components/team/TeamDetailView.tsx';
const listViewPath = 'src/renderer/components/team/TeamListView.tsx';
const taskDetailFeatureEntryPath = 'src/features/team-task-board/renderer/index.ts';
const taskDetailPortPath =
  'src/features/team-task-board/renderer/ports/TeamTaskDetailRendererPorts.ts';
const taskDetailTransportPath = 'src/renderer/composition/team/createTeamTaskDetailTransport.ts';
const features = [
  {
    name: 'team-view-read-model',
    ports: 'renderer/ports/TeamListViewReadPorts.ts',
    composition: 'renderer/composition/createTeamListViewReadPorts.ts',
    publicSymbols: ['createTeamListViewReadPorts', 'TeamListViewReadPorts'],
  },
  {
    name: 'team-provisioning',
    ports: 'renderer/ports/TeamListProvisioningPorts.ts',
    composition: 'renderer/composition/createTeamListProvisioningPorts.ts',
    publicSymbols: [
      'createTeamListProvisioningPorts',
      'TeamListProvisioningLaunchPort',
      'TeamListProvisioningPorts',
    ],
  },
  {
    name: 'team-lifecycle',
    ports: 'renderer/ports/TeamListLifecyclePorts.ts',
    composition: 'renderer/composition/createTeamListLifecyclePorts.ts',
    publicSymbols: ['createTeamListLifecyclePorts', 'TeamListLifecyclePorts'],
  },
  {
    name: 'team-roster-mutations',
    ports: 'renderer/ports/TeamListRosterPorts.ts',
    composition: 'renderer/composition/createTeamListRosterPorts.ts',
    publicSymbols: ['createTeamListRosterPorts', 'TeamListRosterPorts'],
  },
] as const;

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

function featurePath(feature: (typeof features)[number], suffix: string): string {
  return `src/features/${feature.name}/${suffix}`;
}

describe('orchestrator-ready team renderer port boundary', () => {
  it('ratchets production TeamListView to zero direct api.teams access', () => {
    const view = source(listViewPath);

    expect(view.match(/\bapi\.teams\b/g) ?? []).toHaveLength(0);
    expect(view).toContain('productionTeamListLifecyclePorts.listAliveTeams()');
    expect(view).toContain('productionTeamListProvisioningPorts.deleteDraft(teamName)');
    expect(view).toContain('.readDraft(teamName)');
    expect(view.match(/productionTeamListReadPorts\.readTeamData\(/g)).toHaveLength(2);
    expect(view.match(/productionTeamListLifecyclePorts\.stopRunningTeam\(/g)).toHaveLength(2);
    expect(view).toContain('productionTeamListRosterPorts.replaceRoster(');
    expect(view.match(/productionTeamListProvisioningPorts\.launchTeam/g)).toHaveLength(2);
  });

  it('requires TeamListView to consume every feature through its renderer public entrypoint', () => {
    const view = source(listViewPath);

    for (const feature of features) {
      expect(view).toContain(`from '@features/${feature.name}/renderer'`);
      expect(view).not.toMatch(
        new RegExp(`@features/${feature.name}/renderer/(?:ports|composition|adapters)/`)
      );

      const publicEntry = source(featurePath(feature, 'renderer/index.ts'));
      for (const symbol of feature.publicSymbols) {
        expect(publicEntry, `${feature.name} must publicly export ${symbol}`).toContain(symbol);
      }
    }
  });

  it('keeps feature-owned port contracts provider, transport, process, and store neutral', () => {
    const forbiddenPortSurface =
      /@renderer\/|ElectronAPI|window\.electronAPI|\bapi\.teams\b|OpenCode|opencode|child_process|TeamProvisioningService|renderer\/store/;

    for (const feature of features) {
      const ports = source(featurePath(feature, feature.ports));
      expect(ports, feature.name).not.toMatch(forbiddenPortSurface);
      expect(ports, feature.name).toMatch(/export interface TeamList/);
    }
  });

  it('confines the legacy api.teams adapter to feature composition and retains one launch owner', () => {
    const compositions = features.map((feature) =>
      source(featurePath(feature, feature.composition))
    );
    const combined = compositions.join('\n');
    const provisioning = compositions[1];

    expect(combined).not.toMatch(/OpenCode|opencode|child_process|TeamProvisioningService/);
    expect(combined).not.toContain('@renderer/api');
    expect(combined.match(/\blegacyApi\.teams\b/g)).toHaveLength(6);
    expect(provisioning).not.toContain('legacyApi.teams.launchTeam');
    expect(provisioning).toContain('launch.launchTeam(request)');
    expect(source(listViewPath).match(/createTeamList\w+Ports\(api/g)).toHaveLength(4);
    expect(source(listViewPath)).toContain('useStore.getState().launchTeam(request)');
  });

  it('routes TeamDetail stop, roster replacement, and launch through the existing public ports', () => {
    const detailView = source(detailViewPath);
    const relaunchStart = detailView.indexOf('const handleRelaunchDialogSubmit');
    const relaunchEnd = detailView.indexOf('const handleChangeLeadRuntime', relaunchStart);
    const relaunch = detailView.slice(relaunchStart, relaunchEnd);

    expect(detailView).not.toMatch(/\bapi\.teams\.(?:replaceMembers|stop)\b/);
    expect(detailView.match(/detailLifecyclePorts\.stopRunningTeam\(/g)).toHaveLength(2);
    expect(detailView).toContain('detailRosterPorts.replaceRoster(');
    expect(detailView.match(/detailProvisioningPorts\.launchTeam/g)).toHaveLength(2);
    expect(relaunchStart).toBeGreaterThan(-1);
    expect(relaunchEnd).toBeGreaterThan(relaunchStart);
    expect(relaunch.indexOf('stopRunningTeam')).toBeLessThan(relaunch.indexOf('replaceRoster'));
    expect(relaunch.indexOf('replaceRoster')).toBeLessThan(relaunch.indexOf('launchTeam'));

    for (const featureName of ['team-lifecycle', 'team-provisioning', 'team-roster-mutations']) {
      expect(detailView).toContain(`from '@features/${featureName}/renderer'`);
      expect(detailView).not.toMatch(
        new RegExp(`@features/${featureName}/renderer/(?:ports|composition|adapters)/`)
      );
    }

    expect(detailView.match(/createTeamList\w+Ports\(api/g)).toHaveLength(3);
    expect(detailView).toContain('useStore.getState().launchTeam(request)');
    expect(detailView).not.toContain('launchTeam: s.launchTeam');
  });

  it('ratchets TeamDetailView to zero direct api.teams access', () => {
    const detailView = source(detailViewPath);

    expect(detailView.match(/\bapi\.teams\b/g) ?? []).toHaveLength(0);
    expect(detailView.match(/\bwindow\.electronAPI\.teams\b/g) ?? []).toHaveLength(0);
    expect(detailView).toMatch(/detailTaskPorts\s*\.readTask\(teamName, selectedTaskId\)/);
    expect(detailView.match(/detailTaskPorts\.notifyTaskLead\(/g) ?? []).toHaveLength(4);
  });

  it('preserves TeamDetailView lifecycle, provisioning, and store owners', () => {
    const detailView = source(detailViewPath);

    expect(detailView).toContain('detailLifecyclePorts.listAliveTeams()');
    expect(detailView).toContain('detailProvisioningPorts.deleteDraft(teamName)');
    expect(detailView).toContain('useStore.getState().sendTeamMessage(teamName, {');
    expect(detailView.match(/sendTeamMessage: s\.sendTeamMessage/g) ?? []).toHaveLength(1);
    expect(detailView).not.toMatch(
      /createTeamLifecycleCommandFeature|TeamIpcHandlerApis|api\.teams\.(?:aliveList|deleteDraft|sendMessage)/
    );
  });

  it('keeps the task-detail contract provider, process, transport, and store neutral', () => {
    const detailView = source(detailViewPath);
    const featureEntry = source(taskDetailFeatureEntryPath);
    const port = source(taskDetailPortPath);

    expect(port).toContain('export interface TeamTaskDetailRendererPorts');
    expect(port).toContain('readTask(teamName: string, taskId: string)');
    expect(port).toContain('notifyTaskLead(teamName: string, message: string)');
    expect(port).not.toMatch(
      /@renderer\/|ElectronAPI|window\.electronAPI|\bapi\.|OpenCode|opencode|Claude|child_process|renderer\/store/
    );
    expect(featureEntry).toContain('TeamTaskDetailRendererPorts');
    expect(detailView).toContain("from '@renderer/composition/team/createTeamTaskDetailTransport'");
    expect(detailView).not.toMatch(
      /@features\/team-task-board\/renderer\/(?:ports|adapters|composition)\//
    );
  });

  it('keeps the outer task-detail transport as the sole legacy mapping point', () => {
    const detailView = source(detailViewPath);
    const featureEntry = source(taskDetailFeatureEntryPath);
    const port = source(taskDetailPortPath);
    const transport = source(taskDetailTransportPath);
    const nonAdapterBoundary = [detailView, featureEntry, port].join('\n');

    expect(transport).toContain("from '@renderer/api'");
    expect(transport.match(/\bapi\.teams\b/g) ?? []).toHaveLength(2);
    expect(transport).toContain('api.teams.getTask(teamName, taskId)');
    expect(transport).toContain('api.teams.processSend(teamName, message)');
    expect(transport).not.toMatch(
      /OpenCode|opencode|Claude|child_process|renderer\/store|TeamIpcHandlerApis/
    );
    expect(nonAdapterBoundary).not.toMatch(/\bapi\.teams\b/);
  });
});
