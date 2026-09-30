import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const logsConsumerPath = 'src/renderer/components/team/useClaudeLogsController.ts';
const statsConsumerPath = 'src/renderer/components/team/members/MemberStatsTab.tsx';
const portPath =
  'src/features/team-view-read-model/renderer/ports/TeamOperationalReadRendererPorts.ts';
const publicEntryPath = 'src/features/team-view-read-model/renderer/index.ts';
const transportPath = 'src/renderer/composition/team/createTeamOperationalReadTransport.ts';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('team operational read renderer boundary', () => {
  it('ratchets feature consumers to zero direct team or Electron API access', () => {
    for (const path of [logsConsumerPath, statsConsumerPath]) {
      const contents = source(path);
      expect(contents, path).not.toMatch(/\bapi\.teams\b|window\.electronAPI\.teams/);
      expect(contents, path).toContain(
        "from '@renderer/composition/team/createTeamOperationalReadTransport'"
      );
    }

    expect(source(logsConsumerPath)).toContain(
      'teamOperationalReadTransport.readLeadLogs(teamName'
    );
    expect(source(statsConsumerPath)).toContain(
      'teamOperationalReadTransport.readMemberStats(teamName, memberName)'
    );
  });

  it('keeps the feature port read-only and provider, process, lifecycle, and transport neutral', () => {
    const port = source(portPath);

    expect(port).toContain('export interface TeamOperationalReadRendererPorts');
    expect(port).toContain('readLeadLogs(');
    expect(port).toContain('readMemberStats(teamName: string, memberName: string)');
    expect(port).not.toMatch(
      /@renderer\/|Electron|window\.|api\.|provider|runtime|process|lifecycle|OpenCode|opencode|Claude|TeamClaudeLogs|child_process|renderer\/store/i
    );
    expect(port).not.toMatch(
      /\b(?:launch|stop|restart|kill|spawn|process|lifecycle|provider|mutate|write|delete)\w*\s*\(/
    );
  });

  it('exports the operational read port only through the renderer public entrypoint', () => {
    const publicEntry = source(publicEntryPath);

    expect(publicEntry).toContain('TeamOperationalLogPage');
    expect(publicEntry).toContain('TeamOperationalLogQuery');
    expect(publicEntry).toContain('TeamOperationalReadRendererPorts');
    for (const path of [logsConsumerPath, statsConsumerPath, transportPath]) {
      expect(source(path), path).not.toMatch(
        /@features\/team-view-read-model\/renderer\/(?:ports|adapters|composition)\//
      );
    }
  });

  it('confines legacy operational API names to a delegating outer transport', () => {
    const logsConsumer = source(logsConsumerPath);
    const statsConsumer = source(statsConsumerPath);
    const port = source(portPath);
    const transport = source(transportPath);
    const nonTransportBoundary = [logsConsumer, statsConsumer, port].join('\n');

    expect(transport).toContain("from '@renderer/api'");
    expect(transport.match(/\bapi\.teams\b/g) ?? []).toHaveLength(2);
    expect(transport).toContain('api.teams.getClaudeLogs(teamName, query)');
    expect(transport).toContain('api.teams.getMemberStats(teamName, memberName)');
    expect(transport).not.toMatch(
      /window\.electronAPI|renderer\/store|child_process|try\s*{|catch\s*\(|await\s+|unwrapIpc/
    );
    expect(nonTransportBoundary).not.toMatch(/\bgetClaudeLogs\b|\bgetMemberStats\b/);
  });
});
