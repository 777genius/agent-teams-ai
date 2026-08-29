import { describe, expect, it } from 'vitest';

import { CompositeTokenUsageRunSourceDiscovery } from '../CompositeTokenUsageRunSourceDiscovery';

import type { TokenUsageRunDto } from '../../../contracts';

function run(
  source: TokenUsageRunDto['source'],
  providerBackendId?: string,
  model?: string,
  billingMode: TokenUsageRunDto['billingMode'] = 'unknown'
): TokenUsageRunDto {
  return {
    appRunId: `run:${source}`,
    teamName: 'alpha',
    agentName: 'builder',
    runtimeKind: 'gemini',
    providerId: 'gemini',
    providerBackendId,
    model,
    billingMode,
    startedAt: '2026-08-25T00:00:00.000Z',
    status: 'running',
    source,
    sources: [
      {
        id: `source:${source}`,
        appRunId: `run:${source}`,
        sourceType: 'cli_log',
        nativeSessionId: 'native-1',
        discoveredAt: '2026-08-25T00:00:00.000Z',
      },
    ],
  };
}

describe('CompositeTokenUsageRunSourceDiscovery', () => {
  it('does not supplement an absent preferred backend from a stale lower-priority run', async () => {
    const discovery = new CompositeTokenUsageRunSourceDiscovery([
      {
        discoverAppRuns: async () => [
          run('app_launcher', 'api', 'stale-codex-model', 'api'),
        ],
      },
      { discoverAppRuns: async () => [run('team_launch_state')] },
    ]);

    await expect(discovery.discoverAppRuns()).resolves.toMatchObject([
      {
        source: 'team_launch_state',
        providerId: 'gemini',
        providerBackendId: undefined,
        model: undefined,
        billingMode: 'unknown',
      },
    ]);
  });
});
