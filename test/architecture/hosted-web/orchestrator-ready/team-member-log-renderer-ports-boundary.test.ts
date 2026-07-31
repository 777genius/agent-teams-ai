import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const adapterPath =
  'src/features/member-log-stream/renderer/adapters/createMemberLogObservationRendererPorts.ts';
const hookPath = 'src/features/member-log-stream/renderer/hooks/useMemberLogStream.ts';
const portPath =
  'src/features/member-log-stream/renderer/ports/MemberLogObservationRendererPorts.ts';
const publicEntryPath = 'src/features/member-log-stream/renderer/index.ts';
const uiPath = 'src/renderer/components/team/members/MemberLogsTab.tsx';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('orchestrator-ready member-log renderer port boundary', () => {
  it('ratchets the UI and hook to zero direct Teams and member-log-stream transport calls', () => {
    const hook = source(hookPath);
    const ui = source(uiPath);

    for (const rendererSource of [hook, ui]) {
      expect(rendererSource.match(/\bapi\.teams\b/g) ?? []).toHaveLength(0);
      expect(rendererSource.match(/\bapi\.memberLogStream\b/g) ?? []).toHaveLength(0);
    }

    expect(hook).toContain('ports.readMemberLogStream({');
    expect(hook).toContain('ports.setStreamTracking(input.teamName, true)');
    expect(hook).toContain('ports.subscribeToChanges((event)');
    expect(ui).toContain('memberLogObservationPorts.readTaskLogs(teamName, taskId');
    expect(ui).toContain('memberLogObservationPorts.readMemberLogs(teamName, memberName!)');
  });

  it('requires the legacy UI to consume the feature through its renderer public entrypoint', () => {
    const publicEntry = source(publicEntryPath);
    const ui = source(uiPath);

    expect(ui).toContain("from '@features/member-log-stream/renderer'");
    expect(ui).not.toMatch(/@features\/member-log-stream\/renderer\/(?:adapters|hooks|ports)\//);
    for (const symbol of ['memberLogObservationPorts', 'MemberLogObservationRendererPorts']) {
      expect(publicEntry).toContain(symbol);
    }
  });

  it('keeps the feature-owned port provider, transport, process, and store neutral', () => {
    const port = source(portPath);
    const forbiddenPortSurface =
      /@renderer\/|ElectronAPI|window\.electronAPI|\bapi\.|OpenCode|opencode|child_process|renderer\/store/;

    expect(port).not.toMatch(forbiddenPortSurface);
    expect(port).toContain('export interface MemberLogObservationRendererPorts');
    expect(port).toContain('subscribeToChanges(listener: MemberLogObservationListener)');
  });

  it('confines Teams and member-log-stream transport access to the feature adapter', () => {
    const adapter = source(adapterPath);

    expect(adapter).toContain("from '@renderer/api'");
    expect(adapter.match(/\bapi\.teams\b/g) ?? []).toHaveLength(3);
    expect(adapter.match(/\bapi\.memberLogStream\b/g) ?? []).toHaveLength(3);
    expect(adapter).not.toMatch(/OpenCode|opencode|child_process|renderer\/store/);
  });
});
