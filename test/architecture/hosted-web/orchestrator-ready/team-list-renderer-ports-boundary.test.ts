import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const viewPath = 'src/renderer/components/team/TeamListView.tsx';
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

describe('orchestrator-ready TeamListView renderer port boundary', () => {
  it('ratchets production TeamListView to zero direct api.teams access', () => {
    const view = source(viewPath);

    expect(view.match(/\bapi\.teams\b/g) ?? []).toHaveLength(0);
    expect(view).toContain('productionTeamListLifecyclePorts.listAliveTeams()');
    expect(view).toContain('productionTeamListProvisioningPorts.deleteDraft(teamName)');
    expect(view).toContain('.readDraft(teamName)');
    expect(view.match(/productionTeamListReadPorts\.readTeamData\(/g)).toHaveLength(2);
    expect(view.match(/productionTeamListLifecyclePorts\.stopTeam\(/g)).toHaveLength(2);
    expect(view).toContain('productionTeamListRosterPorts.replaceRoster(');
    expect(view.match(/productionTeamListProvisioningPorts\.launchTeam/g)).toHaveLength(2);
  });

  it('requires TeamListView to consume every feature through its renderer public entrypoint', () => {
    const view = source(viewPath);

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
    expect(source(viewPath).match(/createTeamList\w+Ports\(api/g)).toHaveLength(4);
    expect(source(viewPath)).toContain('useStore.getState().launchTeam(request)');
  });
});
