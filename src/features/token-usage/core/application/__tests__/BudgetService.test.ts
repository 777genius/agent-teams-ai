import { describe, expect, it, vi } from 'vitest';

import { testEvent, testRun } from '../../domain/__tests__/budgetFixtures';
import { TokenUsageAnalyticsService } from '../TokenUsageAnalyticsService';

import type {
  TokenUsageBudgetSettingsDto,
  TokenUsageBudgetStatusDto,
  TokenUsageEventDto,
  TokenUsageRunDto,
} from '../../../contracts';

// Catches closed-screen freshness starvation, concurrent importer writes, erased failure health and month reuse.
function fixture() {
  let now = new Date('2026-10-03T12:00:00.000Z');
  let runs: TokenUsageRunDto[] = [testRun()];
  let events: TokenUsageEventDto[] = [testEvent()];
  let discoveryFails = false;
  let readFails = false;
  let settingsFail = false;
  let enabled = true;
  let settings: TokenUsageBudgetSettingsDto = {
    updatedAt: '2026-10-03T00:00:00.000Z',
    global: { monthlyTokenLimit: 1000, thresholds: [50, 100], notificationsEnabled: true },
  };
  const statuses: TokenUsageBudgetStatusDto[] = [];
  const importer = vi.fn(async () => events);
  const discovery = vi.fn(async () => {
    if (discoveryFails) throw new Error('discovery unavailable');
    return runs;
  });
  const ledger = {
    readSnapshot: async () => {
      if (readFails) throw new Error('ledger unavailable');
      return { runs, events };
    },
    listRuns: async () => runs,
    listEvents: async () => events,
    replaceRunsForSource: async (_source: unknown, next: readonly TokenUsageRunDto[]) => {
      runs = [...next];
    },
    upsertRuns: async (next: readonly TokenUsageRunDto[]) => {
      runs = [...next];
    },
    upsertEvents: async (next: readonly TokenUsageEventDto[]) => {
      events = [...next];
    },
  };
  const service = new TokenUsageAnalyticsService({
    ledger,
    discovery: { discoverAppRuns: discovery },
    importers: [{ importUsage: importer }],
    clock: { now: () => now },
    budgets: {
      getSettings: async () => {
        if (settingsFail) throw new Error('config corrupt');
        return settings;
      },
      updateSettings: async (request) => {
        settings = {
          ...request.settings,
          updatedAt: new Date(Date.parse(settings.updatedAt!) + 1).toISOString(),
        };
        return settings;
      },
    },
    budgetNotificationSettings: {
      getSettings: () => ({
        enabled,
        nativeToasts: false,
        notifyAtWarning: true,
        notifyAtCritical: true,
      }),
    },
    publisher: {
      publishSnapshot: () => undefined,
      publishBudgetStatus: (status) => statuses.push(status),
    },
  });
  return {
    service,
    importer,
    discovery,
    statuses,
    settings: () => settings,
    time: (value: string) => {
      now = new Date(value);
    },
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    discoveryFails: (v: boolean) => {
      discoveryFails = v;
    },
    readFails: (v: boolean) => {
      readFails = v;
    },
    settingsFail: (v: boolean) => {
      settingsFail = v;
    },
    master: (v: boolean) => {
      enabled = v;
    },
  };
}
describe('Budget service lifecycle', () => {
  it('starts stale and Budget is independent of filtered analytics; saved zero target remains', async () => {
    const f = fixture();
    expect((await f.service.getBudgetStatus()).stale).toBe(true);
    const current = f.settings();
    current.teams = {
      'outside-filters': { monthlyTokenLimit: 200, thresholds: [], notificationsEnabled: true },
    };
    const filtered = await f.service.refreshSnapshot({ teamNames: ['missing'] });
    expect(filtered.summary.totalTokens).toBe(0);
    const status = await f.service.getBudgetStatus();
    expect(status.stale).toBe(false);
    expect(status.targets[0].metrics[0].value).toBe(100);
    expect(status.targets[1].metrics[0].value).toBe(0);
  });
  it('failure stays degraded through get/ingest and ledger failure preserves same-month known values', async () => {
    const f = fixture();
    await f.service.refreshSnapshot();
    f.discoveryFails(true);
    await f.service.refreshSnapshot();
    await f.service.ingestEvents([testEvent()]);
    expect((await f.service.getBudgetStatus()).degraded).toBe(true);
    f.readFails(true);
    const status = await f.service.getBudgetStatus();
    expect(status).toMatchObject({ degraded: true, stale: true });
    expect(status.targets[0].metrics[0].value).toBe(100);
    f.readFails(false);
    f.discoveryFails(false);
    await f.service.refreshSnapshot();
    expect((await f.service.getBudgetStatus()).degraded).toBe(false);
    f.advance(300_000);
    expect((await f.service.getBudgetStatus()).stale).toBe(true);
  });
  it('background refreshes while dashboard closed, skips recent UI refresh and stops for pause/master/empty thresholds', async () => {
    const f = fixture();
    await f.service.tick();
    expect(f.importer).toHaveBeenCalledTimes(1);
    f.advance(60_000);
    await f.service.tick();
    expect(f.importer).toHaveBeenCalledTimes(1);
    f.advance(60_000);
    await f.service.tick();
    expect(f.importer).toHaveBeenCalledTimes(2);
    f.settings().global!.notificationsEnabled = false;
    f.advance(120_000);
    await f.service.tick();
    expect(f.importer).toHaveBeenCalledTimes(2);
    f.settings().global!.notificationsEnabled = true;
    f.master(false);
    await f.service.tick();
    expect(f.importer).toHaveBeenCalledTimes(2);
    f.master(true);
    f.settings().global!.thresholds = [];
    await f.service.tick();
    expect(f.importer).toHaveBeenCalledTimes(2);
  });
  it('failed background refresh waits 120 seconds from attempt and succeeds on recovery', async () => {
    const f = fixture();
    f.discoveryFails(true);
    await f.service.tick();
    expect(f.discovery).toHaveBeenCalledTimes(1);
    f.advance(119_999);
    await f.service.tick();
    expect(f.discovery).toHaveBeenCalledTimes(1);
    f.advance(1);
    f.discoveryFails(false);
    await f.service.tick();
    expect(f.discovery).toHaveBeenCalledTimes(2);
    expect((await f.service.getBudgetStatus()).degraded).toBe(false);
  });
  it('month rollover immediately publishes unknown new-month totals then refreshes even after recent old-month attempt', async () => {
    const f = fixture();
    f.time('2026-10-31T23:59:50.000Z');
    await f.service.refreshSnapshot();
    f.statuses.length = 0;
    f.time('2026-11-01T00:00:10.000Z');
    await f.service.tick();
    expect(f.importer).toHaveBeenCalledTimes(2);
    expect(f.statuses[0]).toMatchObject({ period: { key: '2026-11' }, stale: true });
    expect(f.statuses[0].targets[0].metrics[0].value).toBeNull();
    expect(f.statuses[1].targets[0].metrics[0].value).toBe(0);
  });
  it('coalesces overlapping refreshes and serializes Save after current ledger generation', async () => {
    const f = fixture();
    let release!: () => void;
    f.importer.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [testEvent()];
    });
    const first = f.service.refreshSnapshot();
    const second = f.service.refreshSnapshot();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const saved = f.service.updateBudgetSettings({
      expectedUpdatedAt: f.settings().updatedAt!,
      settings: { global: { monthlyTokenLimit: 200, thresholds: [], notificationsEnabled: false } },
    });
    // Wait for the fake importer, not a timer or a real provider.
    while (!release) await Promise.resolve();
    release();
    await Promise.all([first, second, saved]);
    expect(f.importer).toHaveBeenCalledTimes(1);
    expect((await f.service.getBudgetStatus()).targets[0]).toMatchObject({
      notificationsEnabled: false,
      metrics: [{ limit: 200, value: 100 }],
    });
  });
  it('corrupt budget config does not make valid analytics refresh or ingest fail', async () => {
    const f = fixture();
    f.settingsFail(true);
    expect((await f.service.refreshSnapshot()).summary.totalTokens).toBe(100);
    await expect(f.service.ingestEvents([testEvent()])).resolves.toBeUndefined();
    await expect(f.service.getBudgetStatus()).rejects.toThrow('config corrupt');
  });
});
