import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTeamBudgetAdmission,
  createTeamBudgetControls,
} from '@main/services/team/budget/createTeamBudgetControls';

import {
  TOKEN_USAGE_BUDGET_SETTINGS_ROUTE,
  TOKEN_USAGE_BUDGET_STATUS_ROUTE,
} from '../../../../../contracts';
import { testEvent, testRun } from '../../../../../core/domain/__tests__/budgetFixtures';
import { createTokenUsageFeature } from '../../../../composition/createTokenUsageFeature';
import { registerTokenUsageHttp } from '../registerTokenUsageHttp';

import type { TokenUsageFeatureFacade } from '../../../../composition/createTokenUsageFeature';

// The native process path is exercised separately in team-stop escalation tests.
// Here the process adapter is fake; never inspect real profile-owned runtime paths.
vi.mock('@main/services/team/lifecycle/stopTeamWithVerifiedEscalation', () => ({
  stopTeamWithVerifiedEscalation: (name: string, runtime: { stopTeam(team: string): Promise<void> }) =>
    runtime.stopTeam(name),
}));

vi.mock('@features/team-project-context/main', () => ({
  TeamProjectContextRegistry: {
    fromCurrentApp: () => ({
      resolveOwnedExecutionAlias: async () => null,
      resolveOwnedExecutionAliases: async (names: string[]) => new Map(
        names.map((name) => [name, { alias: null }])
      ),
      listOwnedStopCandidates: async () => ({ candidates: [], refused: [] }),
    }),
  },
}));

describe('team budget real persistence, HTTP, admission and stop E2E', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  });

  it('persists opt-in stop policy, starts under limit, then stops and blocks new launches', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'TEST-team-budget-enforcement-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const teamsBasePath = join(directory, 'teams');
    await mkdir(teamsBasePath);

    let alive = true;
    let stopped!: () => void;
    const stopObserved = new Promise<void>((resolve) => { stopped = resolve; });
    const stopTeam = vi.fn(async (name: string) => {
      expect(name).toBe('alpha');
      alive = false;
      stopped();
    });
    const warn = vi.fn();
    let feature: TokenUsageFeatureFacade | null = null;
    const getFeature = () => feature;
    const controls = createTeamBudgetControls(getFeature, {
      getAliveTeams: () => alive ? ['alpha'] : [],
      isTeamManagedByThisProfile: async () => true,
      stopTeam,
      isTeamAlive: async () => alive,
    }, () => ({
      notifyOnUsageBudgetAlerts: false,
      notifyOnUsageBudgetWarning: false,
      notifyOnUsageBudgetCritical: false,
      notifyOnUsageBudgetNativeToast: false,
    }), warn);
    const settingsPath = join(directory, 'budget-settings.json');
    feature = createTokenUsageFeature({
      ledgerPath: join(directory, 'ledger.json'),
      budgetSettingsPath: settingsPath,
      teamsBasePath,
      importers: [],
      budgetTeamNameAliases: controls.resolveBudgetAliases,
      publisher: { publishBudgetStatus: (status) => controls.observer.observe(status) },
    });
    cleanup.push(async () => feature?.dispose());
    const app = Fastify();
    registerTokenUsageHttp(app, feature);
    cleanup.push(() => app.close());

    const saved = await app.inject({
      method: 'PUT',
      url: TOKEN_USAGE_BUDGET_SETTINGS_ROUTE,
      payload: {
        teamIdentityVersion: 1,
        expectedUpdatedAt: null,
        settings: {
          teams: {
            'team:alpha': {
              monthlyTokenLimit: 100, thresholds: [80, 100],
              notificationsEnabled: false, onExceeded: 'stop_team',
            },
          },
        },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toMatchObject({
      schemaVersion: 3,
      settings: { teams: { 'team:alpha': { onExceeded: 'stop_team' } } },
    });

    // First-use refresh is required before a zero-usage team may launch.
    const admit = createTeamBudgetAdmission(getFeature);
    await expect(admit('alpha')).resolves.toBeUndefined();
    expect(stopTeam).not.toHaveBeenCalled();

    const now = new Date().toISOString();
    await feature.recordRuns([testRun({ teamName: 'alpha', startedAt: now })]);
    await feature.ingestEvents([testEvent({ occurredAt: now, createdAt: now })]);
    await stopObserved;
    expect(stopTeam).toHaveBeenCalledExactlyOnceWith('alpha');
    expect(warn).not.toHaveBeenCalled();

    const observed = await app.inject(TOKEN_USAGE_BUDGET_STATUS_ROUTE);
    expect(observed.statusCode).toBe(200);
    expect(observed.json().targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'team:alpha',
        onExceeded: 'stop_team',
        metrics: [expect.objectContaining({ value: 100, limit: 100 })],
      }),
    ]));
    await expect(admit('alpha')).rejects.toThrow('TEAM_BUDGET_BLOCKED');

    const relaxed = await app.inject({
      method: 'PUT',
      url: TOKEN_USAGE_BUDGET_SETTINGS_ROUTE,
      payload: {
        teamIdentityVersion: 1,
        expectedUpdatedAt: saved.json().updatedAt,
        settings: {
          teams: {
            'team:alpha': {
              monthlyTokenLimit: 200, thresholds: [80, 100],
              notificationsEnabled: false, onExceeded: 'stop_team',
            },
          },
        },
      },
    });
    expect(relaxed.statusCode).toBe(200);
    await expect(admit('alpha')).resolves.toBeUndefined();
    // Raising the budget permits admission; it never relaunches a stopped team.
    expect(alive).toBe(false);
  });
});
