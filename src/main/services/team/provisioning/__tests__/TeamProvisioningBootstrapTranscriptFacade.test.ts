import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningBootstrapTranscriptFacadeDepsFromService,
  TeamProvisioningBootstrapTranscriptFacade,
  type TeamProvisioningBootstrapTranscriptFacadeServiceHost,
} from '../TeamProvisioningBootstrapTranscriptFacade';

const NOW = '2026-01-01T00:00:00.000Z';

function transcriptLine(input: { timestamp: string; agentName?: string; text: string }): string {
  return `${JSON.stringify({
    timestamp: input.timestamp,
    ...(input.agentName ? { agentName: input.agentName } : {}),
    text: input.text,
  })}\n`;
}

describe('TeamProvisioningBootstrapTranscriptFacade', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('builds facade deps from service-shaped dependencies', async () => {
    const runtimeAdapterRunByTeam = new Map<string, unknown>();
    const getTrackedRunId = vi.fn((): string | null => null);
    const configReader = {} as TeamProvisioningBootstrapTranscriptFacadeServiceHost['configReader'];
    const inboxReader = {} as TeamProvisioningBootstrapTranscriptFacadeServiceHost['inboxReader'];
    const membersMetaStore =
      {} as TeamProvisioningBootstrapTranscriptFacadeServiceHost['membersMetaStore'];
    const readConfigSnapshot = vi.fn(async () => null);
    const service = {
      runTracking: {
        getTrackedRunId,
      },
      runtimeAdapterRunByTeam,
      configReader,
      inboxReader,
      membersMetaStore,
      configFacade: {
        readConfigSnapshot,
      },
    } satisfies TeamProvisioningBootstrapTranscriptFacadeServiceHost;
    const deps = createTeamProvisioningBootstrapTranscriptFacadeDepsFromService(service, {
      nowIso: () => NOW,
    });

    expect(deps.nowIso()).toBe(NOW);
    expect(deps.configReader).toBe(configReader);
    expect(deps.inboxReader).toBe(inboxReader);
    expect(deps.membersMetaStore).toBe(membersMetaStore);
    expect(deps.isLookupCacheEnabled('alpha')).toBe(true);
    runtimeAdapterRunByTeam.set('alpha', {});
    expect(deps.isLookupCacheEnabled('alpha')).toBe(false);
    runtimeAdapterRunByTeam.clear();
    getTrackedRunId.mockReturnValue('run-1');
    expect(deps.isLookupCacheEnabled('alpha')).toBe(false);
    await deps.readConfigSnapshot('alpha');

    expect(readConfigSnapshot).toHaveBeenCalledWith('alpha');
  });

  it('owns transcript outcome lookup ports and exposes their parsed tail cache', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-transcript-facade-'));
    const transcriptPath = path.join(tmpDir, 'member.jsonl');
    await fs.writeFile(
      transcriptPath,
      transcriptLine({
        timestamp: '2026-05-24T09:25:42.904Z',
        agentName: 'alice',
        text: 'member briefing for alice on team "demo-team" (demo-team). Ready.',
      }),
      'utf8'
    );
    const findMemberLogs = vi.fn(async () => [{ filePath: transcriptPath }]);
    const readConfigSnapshot = vi.fn(async () => null);
    const readMetaMembers = vi.fn(async () => []);
    const facade = new TeamProvisioningBootstrapTranscriptFacade({
      nowIso: () => NOW,
      isLookupCacheEnabled: () => false,
      memberLogsFinder: { findMemberLogs },
      persistedTranscriptClaudeLogs: {
        get: vi.fn(async () => null),
        invalidate: vi.fn(),
      },
      readConfigSnapshot,
      readMetaMembers,
    });

    await expect(facade.findBootstrapTranscriptOutcome('demo-team', 'alice', 123)).resolves.toEqual(
      {
        kind: 'success',
        observedAt: '2026-05-24T09:25:42.904Z',
        source: 'member_briefing',
      }
    );

    expect(findMemberLogs).toHaveBeenCalledWith('demo-team', 'alice', 123);
    expect(readConfigSnapshot).toHaveBeenCalledWith('demo-team');
    expect(readMetaMembers).toHaveBeenCalledWith('demo-team');
    expect(facade.parsedBootstrapTranscriptTailCache.size).toBe(1);
  });

  it('delegates persisted Claude transcript log reads and invalidation', async () => {
    const snapshot = {
      lines: ['line-1'],
      updatedAt: '2026-05-24T09:25:42.904Z',
    };
    const get = vi.fn(async () => snapshot);
    const invalidate = vi.fn();
    const facade = new TeamProvisioningBootstrapTranscriptFacade({
      nowIso: () => NOW,
      isLookupCacheEnabled: () => false,
      memberLogsFinder: { findMemberLogs: vi.fn(async () => []) },
      persistedTranscriptClaudeLogs: { get, invalidate },
      readConfigSnapshot: vi.fn(async () => null),
      readMetaMembers: vi.fn(async () => []),
    });

    await expect(facade.getPersistedTranscriptClaudeLogs('alpha')).resolves.toBe(snapshot);
    facade.invalidatePersistedTranscriptClaudeLogs('alpha');

    expect(get).toHaveBeenCalledWith('alpha');
    expect(invalidate).toHaveBeenCalledWith('alpha');
  });

  it('owns persisted Claude transcript log cache creation from transcript project context', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-transcript-facade-'));
    const projectDir = tmpDir;
    const leadSessionId = 'lead-session';
    const transcriptPath = path.join(projectDir, `${leadSessionId}.jsonl`);
    await fs.writeFile(transcriptPath, 'first line\n\nsecond line\n', 'utf8');
    const getContext = vi.fn(async () => ({
      projectDir,
      projectId: 'project-alpha',
      config: { name: 'alpha', leadSessionId },
      sessionIds: [leadSessionId],
    }));
    const facade = new TeamProvisioningBootstrapTranscriptFacade({
      nowIso: () => NOW,
      isLookupCacheEnabled: () => false,
      memberLogsFinder: { findMemberLogs: vi.fn(async () => []) },
      transcriptProjectResolver: { getContext },
      readConfigSnapshot: vi.fn(async () => null),
      readMetaMembers: vi.fn(async () => []),
    });

    await expect(facade.getPersistedTranscriptClaudeLogs('alpha')).resolves.toMatchObject({
      lines: ['first line', 'second line'],
    });

    expect(getContext).toHaveBeenCalledWith('alpha');
  });
});
