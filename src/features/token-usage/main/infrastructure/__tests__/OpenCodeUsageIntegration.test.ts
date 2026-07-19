import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { createTokenUsageFeature } from '../../composition/createTokenUsageFeature';
import { resolveClaudeMultimodelDataHomePath } from '../OpenCodeSessionStoreRunSourceDiscovery';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OpenCode usage integration', () => {
  it('imports exact assistant usage from a managed OpenCode profile database', async () => {
    const fixture = await createFixture({ includeLaunchState: false });
    insertMessage(fixture.databasePath, {
      id: 'msg-assistant-1',
      sessionId: fixture.sessionId,
      createdAt: Date.now() - 2_000,
      data: {
        role: 'assistant',
        providerID: 'xai',
        modelID: 'grok-4.3',
        time: { created: Date.now() - 2_000, completed: Date.now() - 1_000 },
        tokens: {
          total: 17,
          input: 10,
          output: 2,
          reasoning: 0,
          cache: { read: 5, write: 0 },
        },
        cost: 0.25,
        finish: 'stop',
      },
    });
    insertMessage(fixture.databasePath, {
      id: 'msg-aborted-zero',
      sessionId: fixture.sessionId,
      createdAt: Date.now(),
      data: {
        role: 'assistant',
        providerID: 'xai',
        modelID: 'grok-4.3',
        time: { created: Date.now(), completed: Date.now() },
        tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        cost: 0,
        error: { name: 'MessageAbortedError' },
      },
    });

    const snapshot = await fixture.feature.refreshSnapshot({
      from: new Date(Date.now() - 60_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(snapshot.degraded).toBe(false);
    expect(snapshot.summary).toEqual(
      expect.objectContaining({
        requestCount: 1,
        runCount: 1,
        totalTokens: 17,
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 5,
        subscriptionRequestCount: 1,
        billableCostUsd: 0,
        apiEquivalentCostUsd: 0.25,
        exactEventCount: 1,
      })
    );
    expect(snapshot.byModel[0]).toEqual(
      expect.objectContaining({ id: 'xai/grok-4.3', label: 'xai/grok-4.3' })
    );
    expect(snapshot.byTeam[0]?.id).toBe('usage-opencode-test');
  });

  it('merges launch-state and session-store evidence for the same OpenCode session', async () => {
    const fixture = await createFixture({ includeLaunchState: true });
    insertMessage(fixture.databasePath, {
      id: 'msg-assistant-merged',
      sessionId: fixture.sessionId,
      createdAt: Date.now() - 1_000,
      data: {
        role: 'assistant',
        providerID: 'xiaomi-token-plan-sgp',
        modelID: 'mimo-v2.5-pro',
        time: { created: Date.now() - 1_000, completed: Date.now() },
        tokens: { total: 23, input: 20, output: 3, cache: { read: 0, write: 0 } },
        cost: 0,
        finish: 'stop',
      },
    });

    const snapshot = await fixture.feature.refreshSnapshot();

    expect(snapshot.summary.runCount).toBe(1);
    expect(snapshot.summary.requestCount).toBe(1);
    expect(snapshot.summary.totalTokens).toBe(23);
    expect(snapshot.recentRuns).toHaveLength(1);
    expect(snapshot.recentRuns[0]?.sources[0]?.nativeLogPath).toBe(fixture.databasePath);
  });

  it('imports Kiro credits once per assistant turn when text and reasoning parts mirror metadata', async () => {
    const fixture = await createFixture({ includeLaunchState: false, model: 'kiro/auto' });
    const completedAt = Date.now() - 1_000;
    insertMessage(fixture.databasePath, {
      id: 'msg-kiro-credits',
      sessionId: fixture.sessionId,
      createdAt: completedAt - 1_000,
      data: {
        role: 'assistant',
        providerID: 'kiro',
        modelID: 'auto',
        time: { created: completedAt - 1_000, completed: completedAt },
        tokens: { total: 9, input: 6, output: 3, cache: { read: 0, write: 0 } },
        cost: 0,
        finish: 'stop',
      },
    });
    insertPart(fixture.databasePath, {
      id: 'part-reasoning',
      messageId: 'msg-kiro-credits',
      sessionId: fixture.sessionId,
      data: {
        type: 'reasoning',
        text: 'thinking',
        metadata: { kiro: { credits: 0.07, creditsUnit: 'credit' } },
      },
    });
    insertPart(fixture.databasePath, {
      id: 'part-text',
      messageId: 'msg-kiro-credits',
      sessionId: fixture.sessionId,
      data: {
        type: 'text',
        text: 'done',
        metadata: { kiro: { credits: 0.07, creditsUnit: 'credit' } },
      },
    });

    const snapshot = await fixture.feature.refreshSnapshot();

    expect(snapshot.summary).toEqual(
      expect.objectContaining({
        requestCount: 1,
        kiroCredits: 0.07,
        kiroCreditEventCount: 1,
        lastKiroCredits: 0.07,
        kiroCreditsUnit: 'credit',
      })
    );
    expect(snapshot.byTeam[0]?.summary.kiroCredits).toBe(0.07);
    expect(snapshot.byAgent[0]?.summary.kiroCredits).toBe(0.07);
    expect(snapshot.bySession[0]?.summary.kiroCredits).toBe(0.07);
    expect(snapshot.sessionRuns[0]?.summary.kiroCredits).toBe(0.07);
  });

  it('imports a credit-only Kiro turn and ignores malformed or non-Kiro metadata', async () => {
    const fixture = await createFixture({ includeLaunchState: false, model: 'kiro/auto' });
    const now = Date.now();
    insertMessage(fixture.databasePath, {
      id: 'msg-kiro-credit-only',
      sessionId: fixture.sessionId,
      createdAt: now - 2_000,
      data: {
        role: 'assistant',
        providerID: 'kiro',
        modelID: 'auto',
        time: { created: now - 2_000, completed: now - 1_000 },
        tokens: { input: 0, output: 0 },
        cost: 0,
      },
    });
    insertPart(fixture.databasePath, {
      id: 'part-credit-only',
      messageId: 'msg-kiro-credit-only',
      sessionId: fixture.sessionId,
      data: { type: 'text', metadata: { kiro: { credits: 0.03, creditsUnit: 'credit' } } },
    });
    insertMessage(fixture.databasePath, {
      id: 'msg-non-kiro',
      sessionId: fixture.sessionId,
      createdAt: now,
      data: {
        role: 'assistant',
        providerID: 'xai',
        modelID: 'grok-4.3',
        time: { created: now, completed: now },
        tokens: { total: 1, input: 1, output: 0 },
      },
    });
    insertPart(fixture.databasePath, {
      id: 'part-non-kiro',
      messageId: 'msg-non-kiro',
      sessionId: fixture.sessionId,
      data: { type: 'text', metadata: { kiro: { credits: 99, creditsUnit: 'credit' } } },
    });

    const snapshot = await fixture.feature.refreshSnapshot();

    expect(snapshot.summary.kiroCredits).toBe(0.03);
    expect(snapshot.summary.kiroCreditEventCount).toBe(1);
    expect(snapshot.summary.requestCount).toBe(2);
  });

  it('resolves the orchestrator data home consistently across desktop platforms', () => {
    expect(
      resolveClaudeMultimodelDataHomePath({
        platform: 'darwin',
        homeDir: '/Users/test',
        env: {},
      })
    ).toBe('/Users/test/Library/Application Support/claude-multimodel-nodejs');
    expect(
      resolveClaudeMultimodelDataHomePath({
        platform: 'linux',
        homeDir: '/home/test',
        env: { XDG_DATA_HOME: '/data' },
      })
    ).toBe('/data/claude-multimodel-nodejs');
    expect(
      resolveClaudeMultimodelDataHomePath({
        platform: 'win32',
        homeDir: 'C:\\Users\\test',
        env: { LOCALAPPDATA: 'D:\\Local' },
      })
    ).toBe(path.join('D:\\Local', 'claude-multimodel-nodejs', 'Data'));
    expect(
      resolveClaudeMultimodelDataHomePath({
        platform: 'linux',
        homeDir: '/home/test',
        env: { CLAUDE_MULTIMODEL_DATA_HOME: '/custom/runtime-data' },
      })
    ).toBe('/custom/runtime-data');
  });
});

async function createFixture({
  includeLaunchState,
  model = 'xai/grok-4.3',
}: {
  includeLaunchState: boolean;
  model?: string;
}): Promise<{
  databasePath: string;
  sessionId: string;
  feature: ReturnType<typeof createTokenUsageFeature>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'token-usage-opencode-'));
  roots.push(root);
  const teamsBasePath = path.join(root, 'teams');
  const teamName = 'usage-opencode-test';
  const teamDir = path.join(teamsBasePath, teamName);
  const dataHomePath = path.join(root, 'runtime-data');
  const profileRootKey = '0123456789abcdef';
  const sessionId = 'ses_usage_test_1';
  const projectPath = path.join(root, 'project');
  const databasePath = path.join(
    dataHomePath,
    'opencode',
    'profiles',
    profileRootKey,
    'data',
    'opencode',
    'opencode.db'
  );
  await mkdir(teamDir, { recursive: true });
  await mkdir(path.dirname(databasePath), { recursive: true });
  await writeFile(
    path.join(teamDir, 'config.json'),
    JSON.stringify({
      name: teamName,
      projectPath,
      members: [
        {
          name: 'worker',
          providerId: 'opencode',
          model,
        },
      ],
    })
  );
  if (includeLaunchState) {
    await writeFile(
      path.join(teamDir, 'launch-state.json'),
      JSON.stringify({
        version: 2,
        teamName,
        updatedAt: new Date().toISOString(),
        members: {
          worker: {
            name: 'worker',
            providerId: 'opencode',
            model: 'xiaomi-token-plan-sgp/mimo-v2.5-pro',
            runtimeRunId: 'runtime-run-1',
            runtimeSessionId: sessionId,
            runtimeAlive: false,
            hardFailure: false,
            firstSpawnAcceptedAt: new Date(Date.now() - 5_000).toISOString(),
            lastRuntimeAliveAt: new Date(Date.now() - 1_000).toISOString(),
            lastEvaluatedAt: new Date().toISOString(),
          },
        },
      })
    );
  }
  await mkdir(path.join(dataHomePath, 'opencode'), { recursive: true });
  await writeFile(
    path.join(dataHomePath, 'opencode', 'session-store.json'),
    JSON.stringify({
      schemaVersion: 1,
      records: {
        [`${teamName}::primary::worker`]: {
          teamId: teamName,
          memberName: 'worker',
          providerId: 'opencode',
          selectedModel: includeLaunchState ? 'xiaomi-token-plan-sgp/mimo-v2.5-pro' : model,
          projectPath,
          profileRootKey,
          opencodeSessionId: sessionId,
          lastKnownDurableState: 'idle',
          createdAt: new Date(Date.now() - 5_000).toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    })
  );
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      data text NOT NULL
    )
  `);
  database.close();
  await writeFile(
    path.join(path.dirname(databasePath), 'auth.json'),
    JSON.stringify({
      xai: { type: 'oauth' },
      'xiaomi-token-plan-sgp': { type: 'api' },
    })
  );

  return {
    databasePath,
    sessionId,
    feature: createTokenUsageFeature({
      ledgerPath: path.join(root, 'usage', 'ledger.json'),
      teamsBasePath,
      openCodeDataHomePath: dataHomePath,
    }),
  };
}

function insertPart(
  databasePath: string,
  input: { id: string; messageId: string; sessionId: string; data: unknown }
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare('INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)')
      .run(input.id, input.messageId, input.sessionId, JSON.stringify(input.data));
  } finally {
    database.close();
  }
}

function insertMessage(
  databasePath: string,
  input: { id: string; sessionId: string; createdAt: number; data: unknown }
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
      )
      .run(input.id, input.sessionId, input.createdAt, input.createdAt, JSON.stringify(input.data));
  } finally {
    database.close();
  }
}
