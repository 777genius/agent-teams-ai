import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeTokenUsageBudgetSettings } from '../../../contracts';
import { budgetCoverageKey } from '../../../core/domain';
import { JsonTokenUsageBudgetNotificationStateRepository } from '../JsonTokenUsageBudgetNotificationStateRepository';
import { JsonTokenUsageBudgetSettingsRepository } from '../JsonTokenUsageBudgetSettingsRepository';
import { JsonTokenUsageLedgerRepository } from '../JsonTokenUsageLedgerRepository';

import type { TokenUsageBudgetNotificationRecord } from '../../../core/application';

const fault = vi.hoisted(() => ({ path: '', enabled: false }));
vi.mock('@main/utils/atomicWrite', async (original) => {
  const actual = await original<typeof import('@main/utils/atomicWrite')>();
  return {
    ...actual,
    atomicWriteAsync: async (...args: Parameters<typeof actual.atomicWriteAsync>) => {
      if (fault.enabled && args[0] === fault.path) throw new Error('disk full');
      return actual.atomicWriteAsync(...args);
    },
  };
});
const dirs: string[] = [];
afterEach(async () => {
  fault.enabled = false;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function path(name = 'settings.json') {
  const dir = await mkdtemp(join(tmpdir(), 'TEST-budget-'));
  dirs.push(dir);
  return join(dir, name);
}
const limit = { monthlyTokenLimit: 100, thresholds: [90, 50], notificationsEnabled: true };
const record = (
  patch: Partial<TokenUsageBudgetNotificationRecord> = {}
): TokenUsageBudgetNotificationRecord => ({
  dedupeKey: 'legacy:key',
  sentAt: '2026-10-03T00:00:00.000Z',
  periodKey: '2026-10',
  scope: 'project',
  id: 'project:a:b',
  metric: 'tokens',
  threshold: 100,
  value: 110,
  limit: 100,
  percent: 110,
  ...patch,
});

describe('strict Budget persistence', () => {
  // Catches lost concurrent writes, client timestamp trust, v2 empty-threshold defaults, corrupt-file overwrites.
  it('CAS allows one same-revision Save, assigns monotonic server time, recovers queue after conflict', async () => {
    const file = await path();
    const repo = new JsonTokenUsageBudgetSettingsRepository(
      file,
      undefined,
      () => new Date('2026-10-03T00:00:00.000Z')
    );
    const first = await repo.updateSettings({
      settings: { global: limit },
      expectedUpdatedAt: null,
    });
    expect(first.global?.thresholds).toEqual([50, 90]);
    expect(
      normalizeTokenUsageBudgetSettings(JSON.parse(await readFile(file, 'utf8'))).global
    ).toBeUndefined();
    const writes = await Promise.allSettled([
      repo.updateSettings({
        settings: { global: { ...limit, monthlyTokenLimit: 200 } },
        expectedUpdatedAt: first.updatedAt!,
      }),
      repo.updateSettings({
        settings: { global: { ...limit, monthlyTokenLimit: 300 } },
        expectedUpdatedAt: first.updatedAt!,
      }),
    ]);
    expect(writes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const saved = await repo.getSettings();
    expect(saved.global?.monthlyTokenLimit).toBe(200);
    expect(Date.parse(saved.updatedAt!)).toBe(Date.parse(first.updatedAt!) + 1);
    await repo.updateSettings({
      settings: { global: { ...limit, thresholds: [] } },
      expectedUpdatedAt: saved.updatedAt!,
    });
    expect(
      (await new JsonTokenUsageBudgetSettingsRepository(file).getSettings()).global?.thresholds
    ).toEqual([]);
  });
  it.each([
    [true, true, [80, 100]],
    [true, false, [80]],
    [false, true, [100]],
    [false, false, []],
  ] as const)(
    'migrates v1 flags %s %s while preserving master-off',
    async (warning, critical, thresholds) => {
      const file = await path();
      await writeFile(
        file,
        JSON.stringify({ schemaVersion: 1, global: { monthlyTokenLimit: 100 } })
      );
      const repo = new JsonTokenUsageBudgetSettingsRepository(file, {
        getSettings: () => ({
          enabled: false,
          notifyAtWarning: warning,
          notifyAtCritical: critical,
          nativeToasts: false,
        }),
      });
      expect((await repo.getSettings()).global).toMatchObject({
        thresholds,
        notificationsEnabled: true,
      });
      expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(2);
    }
  );
  it('migration failure retains v1 and can retry without alerts or empty fallback', async () => {
    const file = await path();
    const previous = JSON.stringify({ schemaVersion: 1, global: { monthlyTokenLimit: 100 } });
    await writeFile(file, previous);
    fault.path = file;
    fault.enabled = true;
    const repo = new JsonTokenUsageBudgetSettingsRepository(file);
    await expect(repo.getSettings()).rejects.toThrow('disk full');
    expect(await readFile(file, 'utf8')).toBe(previous);
    fault.enabled = false;
    expect((await repo.getSettings()).global?.thresholds).toEqual([80, 100]);
  });
  it.each([
    { ...limit, monthlyTokenLimit: 0 },
    { ...limit, monthlyTokenLimit: Infinity },
    { ...limit, thresholds: [1, 1] },
    { ...limit, thresholds: [0] },
    { ...limit, thresholds: Array.from({ length: 11 }, (_, i) => i + 1) },
    { ...limit, monthlyTokenLimit: undefined },
  ])('rejects invalid Save without writing %j', async (invalid) => {
    const file = await path();
    const repo = new JsonTokenUsageBudgetSettingsRepository(file);
    await expect(
      repo.updateSettings({ settings: { global: invalid }, expectedUpdatedAt: null })
    ).rejects.toThrow();
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('accepts boundary thresholds 1/100 and keeps previous settings after atomic failure', async () => {
    const file = await path();
    const repo = new JsonTokenUsageBudgetSettingsRepository(file);
    const saved = await repo.updateSettings({
      settings: { global: { ...limit, thresholds: [100, 1] } },
      expectedUpdatedAt: null,
    });
    const before = await readFile(file, 'utf8');
    fault.path = file;
    fault.enabled = true;
    await expect(
      repo.updateSettings({ settings: {}, expectedUpdatedAt: saved.updatedAt! })
    ).rejects.toThrow('disk full');
    expect(await readFile(file, 'utf8')).toBe(before);
    fault.enabled = false;
    await repo.updateSettings({ settings: {}, expectedUpdatedAt: saved.updatedAt! });
    expect((await repo.getSettings()).global).toBeUndefined();
  });
  it('migrates sent 100 to exactly 100/80 using structural colon-containing identity', async () => {
    const file = await path('coverage.json');
    const raw = JSON.stringify({ schemaVersion: 1, sent: { 'unparseable:legacy:key': record() } });
    await writeFile(file, raw);
    const repo = new JsonTokenUsageBudgetNotificationStateRepository(file);
    expect(await repo.hasSent(budgetCoverageKey(record()))).toBe(true);
    expect(await repo.hasSent(budgetCoverageKey(record({ threshold: 80 })))).toBe(true);
    expect(await repo.hasSent(budgetCoverageKey(record({ threshold: 70 })))).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(raw);
    await repo.markCovered([]);
    expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(2);
  });
  it('serializes whole metric batches and prune without losing coverage', async () => {
    const file = await path('coverage.json');
    const repo = new JsonTokenUsageBudgetNotificationStateRepository(file);
    await Promise.all([
      repo.markCovered([
        record({ threshold: 50 }),
        record({ metric: 'apiEquivalentCostUsd', threshold: 90 }),
      ]),
      repo.markCovered([record({ periodKey: '2026-07' })]),
      repo.pruneBeforePeriod('2026-08'),
    ]);
    const persisted = JSON.parse(await readFile(file, 'utf8')).sent;
    expect(Object.keys(persisted)).toHaveLength(2);
    expect(await repo.hasSent(budgetCoverageKey(record({ threshold: 50 })))).toBe(true);
    expect(
      await repo.hasSent(
        budgetCoverageKey(record({ metric: 'apiEquivalentCostUsd', threshold: 90 }))
      )
    ).toBe(true);
  });
  it.each([
    '{broken',
    JSON.stringify({ schemaVersion: 99, sent: {} }),
    JSON.stringify({ schemaVersion: 2, sent: { invalid: record({ periodKey: '2026-99' }) } }),
    ' '.repeat(512 * 1024 + 1),
  ])('rejects unreadable coverage without replacing or treating it as unsent', async (raw) => {
    const file = await path('coverage.json');
    await writeFile(file, raw);
    const repo = new JsonTokenUsageBudgetNotificationStateRepository(file);
    await expect(repo.hasSent('key')).rejects.toThrow();
    await expect(repo.markCovered([record()])).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(raw);
  });
  it('ledger malformed entry rejects mutation before it can erase unparsed history', async () => {
    const file = await path('ledger.json');
    const raw = JSON.stringify({
      schemaVersion: 1,
      runs: {},
      events: { event: { appRunId: 'sandbox', id: 'event' } },
    });
    await writeFile(file, raw);
    const ledger = new JsonTokenUsageLedgerRepository(file);
    await expect(ledger.readSnapshot()).rejects.toThrow('Invalid token usage event entry');
    await expect(ledger.replaceRunsForSource('team_launch_state', [])).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(raw);
  });
  // A writer must never replace readable state with an oversized file its own reader rejects.
  it.each([undefined, '2026-10-01T00:00:00.000Z'])(
    'retains revision %s for oversized in-memory migration and a smaller CAS Save',
    async (updatedAt) => {
      const file = await path();
      const projects = Object.fromEntries(
        Array.from({ length: 1500 }, (_, index) => [
          `${'é'.repeat(100)}:${index}`,
          { monthlyTokenLimit: 100 },
        ])
      );
      const raw = JSON.stringify({ schemaVersion: 1, projects, updatedAt });
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(512 * 1024);
      await writeFile(file, raw);
      const repo = new JsonTokenUsageBudgetSettingsRepository(
        file,
        undefined,
        () => new Date('2026-10-03T00:00:00.000Z')
      );
      const migrated = await repo.getSettings();
      expect(Object.keys(migrated.projects ?? {})).toHaveLength(1500);
      expect(migrated.projects?.[`${'é'.repeat(100)}:0`]).toEqual({
        monthlyTokenLimit: 100,
        thresholds: [80, 100],
        notificationsEnabled: true,
      });
      expect(
        Buffer.byteLength(JSON.stringify({ schemaVersion: 2, settings: migrated }, null, 2), 'utf8')
      ).toBeGreaterThan(512 * 1024);
      expect(migrated.updatedAt).toBe(updatedAt);
      expect((await new JsonTokenUsageBudgetSettingsRepository(file).getSettings()).updatedAt).toBe(
        updatedAt
      );
      expect(await readFile(file, 'utf8')).toBe(raw);
      await expect(
        repo.updateSettings({
          settings: { global: limit },
          expectedUpdatedAt: '2026-09-01T00:00:00.000Z',
        })
      ).rejects.toThrow('Budget settings changed');
      expect(await readFile(file, 'utf8')).toBe(raw);
      const saved = await repo.updateSettings({
        settings: { global: limit },
        expectedUpdatedAt: updatedAt ?? null,
      });
      expect(saved.updatedAt).toBe('2026-10-03T00:00:00.000Z');
      expect(await new JsonTokenUsageBudgetSettingsRepository(file).getSettings()).toEqual(saved);
      const savedRaw = await readFile(file, 'utf8');
      expect(Buffer.byteLength(savedRaw, 'utf8')).toBeLessThan(512 * 1024);
      expect(JSON.parse(savedRaw).schemaVersion).toBe(2);
      await expect(
        repo.updateSettings({ settings: {}, expectedUpdatedAt: updatedAt ?? null })
      ).rejects.toThrow('Budget settings changed');
      expect(await readFile(file, 'utf8')).toBe(savedRaw);
    }
  );
  it('rejects an oversized Save without replacing previously readable settings', async () => {
    const file = await path();
    const repo = new JsonTokenUsageBudgetSettingsRepository(file);
    const saved = await repo.updateSettings({
      settings: { global: limit },
      expectedUpdatedAt: null,
    });
    const before = await readFile(file, 'utf8');
    const projects = Object.fromEntries(
      Array.from({ length: 2000 }, (_, index) => [`${'é'.repeat(150)}:${index}`, limit])
    );
    await expect(
      repo.updateSettings({ settings: { projects }, expectedUpdatedAt: saved.updatedAt! })
    ).rejects.toThrow('size limit');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await repo.getSettings()).updatedAt).toBe(saved.updatedAt);
  });
  it('keeps expanded legacy coverage readable and allows prune to rescue durable state', async () => {
    const file = await path('coverage.json');
    const sent = Object.fromEntries(
      Array.from({ length: 550 }, (_, index) => [
        `legacy:${index}`,
        record({ id: `${'é'.repeat(100)}:${index}`, periodKey: '2026-07' }),
      ])
    );
    sent.current = record();
    const raw = JSON.stringify({ schemaVersion: 1, sent });
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(512 * 1024);
    await writeFile(file, raw);
    const repo = new JsonTokenUsageBudgetNotificationStateRepository(file);
    const oldRecord = record({ id: `${'é'.repeat(100)}:0`, periodKey: '2026-07' });
    expect(await repo.hasSent(budgetCoverageKey(oldRecord))).toBe(true);
    expect(await repo.hasSent(budgetCoverageKey({ ...oldRecord, threshold: 80 }))).toBe(true);
    expect(await repo.hasSent(budgetCoverageKey(record()))).toBe(true);
    expect(await repo.hasSent('key')).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(raw);
    await expect(repo.markCovered([record({ id: 'new-project' })])).rejects.toThrow('size limit');
    expect(await readFile(file, 'utf8')).toBe(raw);
    await repo.pruneBeforePeriod('2026-08');
    const savedRaw = await readFile(file, 'utf8');
    const saved = JSON.parse(savedRaw);
    expect(Buffer.byteLength(savedRaw, 'utf8')).toBeLessThan(512 * 1024);
    expect(saved.schemaVersion).toBe(2);
    expect(Object.keys(saved.sent)).toHaveLength(2);
    const restarted = new JsonTokenUsageBudgetNotificationStateRepository(file);
    expect(await restarted.hasSent(budgetCoverageKey(oldRecord))).toBe(false);
    expect(await restarted.hasSent(budgetCoverageKey(record()))).toBe(true);
    expect(await restarted.hasSent(budgetCoverageKey(record({ threshold: 80 })))).toBe(true);
    expect(await restarted.hasSent(budgetCoverageKey(record({ id: 'new-project' })))).toBe(false);
  });
  it('rejects oversized coverage batches and retains prior dedupe state', async () => {
    const file = await path('coverage.json');
    const repo = new JsonTokenUsageBudgetNotificationStateRepository(file);
    await repo.markCovered([record()]);
    const before = await readFile(file, 'utf8');
    const records = Array.from({ length: 1500 }, (_, index) =>
      record({ id: `${'é'.repeat(100)}:${index}` })
    );
    await expect(repo.markCovered(records)).rejects.toThrow('size limit');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await repo.hasSent(budgetCoverageKey(record()))).toBe(true);
  });
});
