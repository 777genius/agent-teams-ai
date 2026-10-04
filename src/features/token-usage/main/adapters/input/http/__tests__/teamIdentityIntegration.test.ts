import Fastify from 'fastify';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ANONYMOUS_TEAM_ID,
  LEGACY_COMBINED_TEAM_ID,
  TOKEN_USAGE_BUDGET_SETTINGS_ROUTE,
  TOKEN_USAGE_SNAPSHOT_ROUTE,
} from '../../../../../contracts';
import { normalizeCostBreakdown, normalizeTokenBreakdown } from '../../../../../core/domain';
import { createTokenUsageFeature } from '../../../../composition/createTokenUsageFeature';
import { registerTokenUsageHttp } from '../registerTokenUsageHttp';

import type { TokenUsageAnalyticsSnapshotDto, TokenUsageRunDto } from '../../../../../contracts';
import type { TokenUsageBudgetNotificationEvent } from '../../../../../core/application';

const dirs: string[] = [];
const disposals: (() => void)[] = [];
afterEach(async () => {
  disposals.splice(0).forEach((dispose) => dispose());
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});
const limit = { monthlyTokenLimit: 100, thresholds: [80, 100], notificationsEnabled: true };
async function fixture(coverageVersion?: 1 | 2) {
  const dir = await mkdtemp(join(tmpdir(), 'TEST-usage-identity-http-'));
  dirs.push(dir);
  const teamsBasePath = join(dir, 'TEST-empty-teams');
  await mkdir(teamsBasePath);
  const budgetSettingsPath = join(dir, 'settings.json');
  const budgetNotificationStatePath = join(dir, 'coverage.json');
  const now = new Date().toISOString();
  const periodKey = now.slice(0, 7);
  await writeFile(
    budgetSettingsPath,
    JSON.stringify({
      schemaVersion: 2,
      settings: {
        updatedAt: now,
        teams: { unassigned: limit, 'team:orphan': limit },
      },
    })
  );
  if (coverageVersion)
    await writeFile(
      budgetNotificationStatePath,
      JSON.stringify({
        schemaVersion: coverageVersion,
        sent: {
          old: {
            dedupeKey: 'old:not:parsed',
            scope: 'team',
            id: 'unassigned',
            threshold: 100,
            metric: 'tokens',
            value: 100,
            limit: 100,
            percent: 100,
            sentAt: now,
            periodKey,
          },
          ...(coverageVersion === 2
            ? {
                warning: {
                  dedupeKey: 'also:not:parsed',
                  scope: 'team',
                  id: 'unassigned',
                  threshold: 80,
                  metric: 'tokens',
                  value: 100,
                  limit: 100,
                  percent: 100,
                  sentAt: now,
                  periodKey,
                },
              }
            : {}),
        },
      })
    );
  const notices: TokenUsageBudgetNotificationEvent[] = [];
  const deps = {
    ledgerPath: join(dir, 'ledger.json'),
    budgetSettingsPath,
    budgetNotificationStatePath,
    teamsBasePath,
    importers: [],
    budgetNotificationSink: {
      notifyBudgetThreshold: async (event: TokenUsageBudgetNotificationEvent) => {
        notices.push(event);
      },
    },
    budgetNotificationSettings: {
      getSettings: () => ({
        enabled: true,
        notifyAtWarning: true,
        notifyAtCritical: true,
        nativeToasts: false,
      }),
    },
  };
  const feature = createTokenUsageFeature(deps);
  disposals.push(feature.dispose);
  const runs: TokenUsageRunDto[] = [
    {
      appRunId: 'TEST-anonymous',
      runtimeKind: 'codex',
      agentName: 'builder',
      startedAt: now,
      status: 'completed',
      source: 'manual_import',
      sources: [],
    },
    {
      appRunId: 'TEST-unassigned',
      teamName: 'unassigned',
      runtimeKind: 'codex',
      agentName: 'builder',
      startedAt: now,
      status: 'completed',
      source: 'manual_import',
      sources: [],
    },
  ];
  await feature.recordRuns(runs);
  // Deliberately omit optional event.teamName: identity must come from the matched run.
  await feature.ingestEvents(
    runs.map((run, index) => ({
      id: `TEST-event-${index}`,
      appRunId: run.appRunId,
      runtimeKind: run.runtimeKind,
      agentName: run.agentName,
      tokens: normalizeTokenBreakdown({ totalTokens: index ? 80 : 20 }),
      cost: normalizeCostBreakdown({ source: 'provider', apiEquivalentUsd: 0 }),
      usageSourceKind: 'sdk_exact',
      occurredAt: now,
      createdAt: now,
    }))
  );
  const app = Fastify();
  registerTokenUsageHttp(app, feature);
  return { app, feature, deps, notices, budgetSettingsPath, budgetNotificationStatePath };
}

describe('real JSON ledger, budgets, evaluator and HTTP composition', () => {
  // This catches the original merged row/totals and optional-event-name filtering bug.
  it('splits 20/80 analytics while retaining legacy 100 and routes canonical/raw filters', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject(TOKEN_USAGE_SNAPSHOT_ROUTE);
      expect(response.statusCode).toBe(200);
      const snapshot = response.json<TokenUsageAnalyticsSnapshotDto>();
      expect(snapshot.byTeam.map((row) => [row.id, row.summary.totalTokens])).toEqual([
        ['team:unassigned', 80],
        [ANONYMOUS_TEAM_ID, 20],
      ]);
      expect(snapshot.byAgent).toHaveLength(2);
      expect(snapshot.byTeam.map((row) => row.id)).not.toContain(LEGACY_COMBINED_TEAM_ID);
      const status = await f.feature.getBudgetStatus();
      expect(
        status.targets.find((target) => target.id === LEGACY_COMBINED_TEAM_ID)?.metrics[0].value
      ).toBe(100);
      expect(status.targets.find((target) => target.id === 'team:team:orphan')?.label).toBe(
        'team:orphan'
      );
      for (const [query, expected] of [
        ['teamIds=anonymous', 20],
        ['teamIds=team%3Aunassigned', 80],
        ['teamIds=anonymous&teamName=unassigned', 20],
        ['teamName=unassigned', 80],
        ['teamNames=unassigned', 80],
      ] as const) {
        const scoped = await f.app.inject(`${TOKEN_USAGE_SNAPSHOT_ROUTE}?${query}`);
        expect(scoped.statusCode).toBe(200);
        expect(scoped.json<TokenUsageAnalyticsSnapshotDto>().summary.totalTokens).toBe(expected);
        expect(scoped.json<TokenUsageAnalyticsSnapshotDto>().unmappedEventCount).toBe(0);
      }
      for (const query of [
        'teamIds=unassigned',
        'teamIds=',
        'teamIds=legacy%3Aunassigned',
        'teamIds=team%3A',
      ]) {
        const invalid = await f.app.inject(`${TOKEN_USAGE_SNAPSHOT_ROUTE}?${query}`);
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json()).not.toHaveProperty('summary');
      }
      expect(() => f.feature.getSnapshot({ teamIds: ['unassigned'] })).toThrow(
        'canonical team filter'
      );
    } finally {
      await f.app.close();
    }
  });
  // Accepted legacy coverage must suppress repeats when settings migrate before coverage.
  it.each([1, 2] as const)(
    'suppresses accepted v%s legacy coverage across partial migration/restart',
    async (version) => {
      const f = await fixture(version);
      try {
        await f.feature.refreshSnapshot();
        expect(f.notices).toEqual([]);
        expect(JSON.parse(await readFile(f.budgetSettingsPath, 'utf8')).schemaVersion).toBe(3);
        expect(
          JSON.parse(await readFile(f.budgetNotificationStatePath, 'utf8')).schemaVersion
        ).toBe(version);
        f.feature.dispose();
        const restarted = createTokenUsageFeature(f.deps);
        disposals.push(restarted.dispose);
        await restarted.refreshSnapshot();
        expect(f.notices).toEqual([]);
        const before = await restarted.getBudgetSettings();
        await restarted.updateBudgetSettings({
          teamIdentityVersion: 1,
          expectedUpdatedAt: before.updatedAt!,
          settings: {
            ...before,
            teams: {
              ...before.teams,
              anonymous: { ...limit, monthlyTokenLimit: 20 },
              'team:unassigned': { ...limit, monthlyTokenLimit: 80 },
            },
          },
        });
        expect(f.notices.map((notice) => notice.id).sort()).toEqual([
          'anonymous',
          'team:unassigned',
        ]);
        const status = await restarted.getBudgetStatus();
        expect(
          status.targets
            .filter((target) => target.id !== 'team:team:orphan')
            .map((target) => target.metrics[0].value)
        ).toEqual([100, 20, 80]);
        await restarted.getSnapshot({
          teamIds: ['anonymous'],
          from: '2000-01-01',
          to: '2000-01-02',
        });
        expect(
          (await restarted.getBudgetStatus()).targets.find(
            (target) => target.id === LEGACY_COMBINED_TEAM_ID
          )?.metrics[0].value
        ).toBe(100);
        const third = createTokenUsageFeature(f.deps);
        disposals.push(third.dispose);
        await third.refreshSnapshot();
        expect(f.notices).toHaveLength(2);
      } finally {
        await f.app.close();
      }
    }
  );
  // Creation restrictions and write versions must be enforced by real HTTP + CAS storage.
  it('edits/deletes legacy, rejects recreation and stale raw drafts through HTTP', async () => {
    const f = await fixture(2);
    try {
      const settings = await f.feature.getBudgetSettings();
      const edited = await f.app.inject({
        method: 'PUT',
        url: TOKEN_USAGE_BUDGET_SETTINGS_ROUTE,
        payload: {
          teamIdentityVersion: 1,
          expectedUpdatedAt: settings.updatedAt,
          settings: { teams: { [LEGACY_COMBINED_TEAM_ID]: { ...limit, monthlyTokenLimit: 200 } } },
        },
      });
      expect(edited.statusCode).toBe(200);
      expect(edited.json().teams[LEGACY_COMBINED_TEAM_ID].monthlyTokenLimit).toBe(200);
      const deleted = await f.app.inject({
        method: 'PUT',
        url: TOKEN_USAGE_BUDGET_SETTINGS_ROUTE,
        payload: {
          teamIdentityVersion: 1,
          expectedUpdatedAt: edited.json().updatedAt,
          settings: {},
        },
      });
      expect(deleted.statusCode).toBe(200);
      expect((await f.feature.getBudgetStatus()).options.map((option) => option.id)).not.toContain(
        LEGACY_COMBINED_TEAM_ID
      );
      const before = await readFile(f.budgetSettingsPath, 'utf8');
      const recreated = await f.app.inject({
        method: 'PUT',
        url: TOKEN_USAGE_BUDGET_SETTINGS_ROUTE,
        payload: {
          teamIdentityVersion: 1,
          expectedUpdatedAt: deleted.json().updatedAt,
          settings: { teams: { [LEGACY_COMBINED_TEAM_ID]: limit } },
        },
      });
      expect(recreated.statusCode).toBe(400);
      const staleClient = await f.app.inject({
        method: 'PUT',
        url: TOKEN_USAGE_BUDGET_SETTINGS_ROUTE,
        payload: {
          expectedUpdatedAt: deleted.json().updatedAt,
          settings: { teams: { 'team:unassigned': limit } },
        },
      });
      expect(staleClient.statusCode).toBe(400);
      expect(await readFile(f.budgetSettingsPath, 'utf8')).toBe(before);
    } finally {
      await f.app.close();
    }
  });
});
