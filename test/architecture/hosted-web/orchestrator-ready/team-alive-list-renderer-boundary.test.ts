import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const adapterPath = 'src/renderer/composition/team/createTeamAliveListReadPort.ts';
const consumerPaths = [
  'src/renderer/hooks/useTeamSuggestions.ts',
  'src/renderer/components/team/messages/MessageComposer.tsx',
  'src/renderer/components/sidebar/GlobalTaskList.tsx',
  'src/features/recent-projects/renderer/hooks/useRecentProjectsSection.ts',
  'src/features/running-teams/renderer/hooks/useRunningTeamsSection.ts',
] as const;

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('alive-team renderer read boundary', () => {
  it('keeps the outer composition as the sole legacy alive-list access point', () => {
    const adapter = source(adapterPath);
    const consumers = consumerPaths.map(source);
    const boundary = [adapter, ...consumers].join('\n');

    expect(adapter).toContain("import { api } from '@renderer/api'");
    expect(adapter).toContain('listAliveTeams: () => api.teams.aliveList()');
    expect(boundary.match(/\bapi\.teams\.aliveList\b/g)).toHaveLength(1);
    for (const consumer of consumers) {
      expect(consumer).not.toMatch(/\bapi\.teams\.aliveList\b/);
      expect(consumer).toContain("from '@renderer/composition/team/createTeamAliveListReadPort'");
    }
  });

  it('exposes only the read-only lifecycle capability to all three consumers', () => {
    const adapter = source(adapterPath);
    const consumers = consumerPaths.map(source);

    expect(adapter).toContain("Pick<TeamListLifecyclePorts, 'listAliveTeams'>");
    expect(adapter).not.toMatch(
      /stopRunningTeam|stopRegisteredProcess|permanentlyDelete|softDelete|restore|launchTeam|killProcess/
    );
    expect(adapter.match(/\blistAliveTeams\b/g)).toHaveLength(2);

    for (const consumer of consumers) {
      expect(consumer).toContain('createTeamAliveListReadPort()');
      expect(consumer).toMatch(/\bteamAliveListReadPort\s*\.\s*listAliveTeams\(\)/);
      expect(consumer).not.toMatch(
        /createTeamListLifecyclePorts|stopRunningTeam|stopRegisteredProcess|TeamLifecycleMutation/
      );
    }
  });

  it('retains consumer-owned best-effort and refresh policy outside the transport', () => {
    const suggestions = source(consumerPaths[0]);
    const composer = source(consumerPaths[1]);
    const globalTasks = source(consumerPaths[2]);
    const adapter = source(adapterPath);

    expect(suggestions).toMatch(/try \{[\s\S]*listAliveTeams\(\)[\s\S]*\} catch \{/);
    expect(composer).toContain('if (!teamSelectorOpen) return;');
    expect(composer).toMatch(/listAliveTeams\(\)[\s\S]*\} catch \{/);
    expect(composer).toContain('crossTeamTargetsFetchedRef.current = false;');
    expect(globalTasks).toContain('if (!electronMode) return null;');
    expect(globalTasks).toMatch(/listAliveTeams\(\)[\s\S]*\} catch \{[\s\S]*return null;/);
    expect(adapter).not.toMatch(/isElectronMode|catch|retry|setAliveTeams|useEffect/);
  });
});
