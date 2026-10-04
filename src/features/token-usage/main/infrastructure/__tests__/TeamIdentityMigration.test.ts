import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ANONYMOUS_TEAM_ID, LEGACY_COMBINED_TEAM_ID, namedTeamId } from '../../../contracts';
import { budgetCoverageKey } from '../../../core/domain';
import { JsonTokenUsageBudgetNotificationStateRepository } from '../JsonTokenUsageBudgetNotificationStateRepository';
import { JsonTokenUsageBudgetSettingsRepository } from '../JsonTokenUsageBudgetSettingsRepository';

import type { TokenUsageBudgetNotificationRecord } from '../../../core/application';

const revision = '2026-10-01T00:00:00.000Z';
const now = () => new Date('2026-10-04T12:00:00.000Z');
const limit = { monthlyTokenLimit: 100, thresholds: [80, 100], notificationsEnabled: false };
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});
async function file(name: string) {
  const dir = await mkdtemp(join(tmpdir(), 'TEST-team-identity-'));
  dirs.push(dir);
  return join(dir, name);
}
function coverage(id: string, threshold = 100): TokenUsageBudgetNotificationRecord {
  return {
    id,
    threshold,
    scope: 'team',
    metric: 'tokens',
    periodKey: '2026-10',
    dedupeKey: 'old-unparsed-key',
    sentAt: revision,
    value: 100,
    limit: 100,
    percent: 100,
  };
}
const rawNames = ['unassigned', 'alpha', 'team:alpha', ANONYMOUS_TEAM_ID, LEGACY_COMBINED_TEAM_ID];
const migratedIds = [
  LEGACY_COMBINED_TEAM_ID,
  'team:alpha',
  'team:team:alpha',
  namedTeamId(ANONYMOUS_TEAM_ID),
  namedTeamId(LEGACY_COMBINED_TEAM_ID),
];

describe('durable canonical identity migration', () => {
  // Previously reserved-looking raw names were indistinguishable from encoded names.
  it.each([1, 2])(
    'migrates every v%s raw name, bumps revision once, and fences stale CAS',
    async (schemaVersion) => {
      const path = await file('settings.json');
      const payload = {
        teams: Object.fromEntries(rawNames.map((id) => [id, limit])),
        updatedAt: revision,
      };
      await writeFile(
        path,
        JSON.stringify(
          schemaVersion === 1 ? { schemaVersion, ...payload } : { schemaVersion, settings: payload }
        )
      );
      const repo = new JsonTokenUsageBudgetSettingsRepository(path, undefined, now);
      const migrated = await repo.getSettings();
      expect(Object.keys(migrated.teams ?? {})).toEqual(migratedIds);
      expect(migrated.teams?.[LEGACY_COMBINED_TEAM_ID]).toEqual({
        ...limit,
        notificationsEnabled: schemaVersion === 1,
      });
      expect(migrated.updatedAt).toBe(now().toISOString());
      const durable = await readFile(path, 'utf8');
      expect(JSON.parse(durable).schemaVersion).toBe(3);
      expect(
        await new JsonTokenUsageBudgetSettingsRepository(path, undefined, now).getSettings()
      ).toEqual(migrated);
      await expect(
        repo.updateSettings({ teamIdentityVersion: 1, settings: {}, expectedUpdatedAt: revision })
      ).rejects.toThrow('Budget settings changed');
      expect(await readFile(path, 'utf8')).toBe(durable);
      await expect(
        repo.updateSettings({
          settings: { teams: { 'team:alpha': limit } },
          expectedUpdatedAt: migrated.updatedAt!,
        } as never)
      ).rejects.toThrow('team identity version');
      expect(await readFile(path, 'utf8')).toBe(durable);
    }
  );
  // Orphan coverage must survive migration too; v1 accepted critical also covers warning.
  it.each([1, 2])(
    'deterministically migrates v%s coverage without parsing stored dedupe strings',
    async (schemaVersion) => {
      const path = await file('coverage.json');
      const raw = JSON.stringify({
        schemaVersion,
        sent: Object.fromEntries(rawNames.map((name, index) => [String(index), coverage(name)])),
      });
      await writeFile(path, raw);
      const repo = new JsonTokenUsageBudgetNotificationStateRepository(path);
      for (const id of migratedIds) {
        expect(await repo.hasSent(budgetCoverageKey(coverage(id)))).toBe(true);
        expect(await repo.hasSent(budgetCoverageKey(coverage(id, 80)))).toBe(schemaVersion === 1);
      }
      expect(await repo.hasSent(budgetCoverageKey(coverage(ANONYMOUS_TEAM_ID)))).toBe(false);
      expect(await readFile(path, 'utf8')).toBe(raw);
      await repo.markCovered([]);
      expect(JSON.parse(await readFile(path, 'utf8')).schemaVersion).toBe(3);
      const restarted = new JsonTokenUsageBudgetNotificationStateRepository(path);
      for (const id of migratedIds)
        expect(await restarted.hasSent(budgetCoverageKey(coverage(id)))).toBe(true);
    }
  );
  // An invalid canonical file is a storage failure, never a successful empty configuration.
  it.each(['unassigned', 'team:', 'bogus', 'team: whitespace '])(
    'rejects invalid v3 settings/coverage identity %s without overwrite',
    async (id) => {
      const settingsPath = await file('settings.json');
      const coveragePath = await file('coverage.json');
      const raw = JSON.stringify({
        schemaVersion: 3,
        settings: { teams: { [id]: limit }, updatedAt: revision },
      });
      const rawCoverage = JSON.stringify({ schemaVersion: 3, sent: { corrupt: coverage(id) } });
      await writeFile(settingsPath, raw);
      await writeFile(coveragePath, rawCoverage);
      const settings = new JsonTokenUsageBudgetSettingsRepository(settingsPath);
      const state = new JsonTokenUsageBudgetNotificationStateRepository(coveragePath);
      await expect(settings.getSettings()).rejects.toThrow();
      await expect(
        settings.updateSettings({
          teamIdentityVersion: 1,
          settings: {},
          expectedUpdatedAt: revision,
        })
      ).rejects.toThrow();
      await expect(state.hasSent('new')).rejects.toThrow();
      await expect(state.markCovered([])).rejects.toThrow();
      expect(await readFile(settingsPath, 'utf8')).toBe(raw);
      expect(await readFile(coveragePath, 'utf8')).toBe(rawCoverage);
    }
  );
  // Expanded identity encoding can exceed the cap; old drafts must still be rejected.
  it.each([1, 2])(
    'retains oversized v%s durable revision and supports smaller canonical rescue',
    async (schemaVersion) => {
      const path = await file('settings.json');
      const teams = Object.fromEntries(
        Array.from({ length: 1500 }, (_, index) => [
          `team:${'é'.repeat(100)}:${index}`,
          schemaVersion === 1 ? { monthlyTokenLimit: 100 } : limit,
        ])
      );
      const payload = { teams, updatedAt: revision };
      const raw = JSON.stringify(
        schemaVersion === 1 ? { schemaVersion, ...payload } : { schemaVersion, settings: payload }
      );
      expect(Buffer.byteLength(raw)).toBeLessThan(512 * 1024);
      await writeFile(path, raw);
      const repo = new JsonTokenUsageBudgetSettingsRepository(path, undefined, now);
      const migrated = await repo.getSettings();
      expect(migrated.updatedAt).toBe(revision);
      expect(migrated.teams?.[`team:team:${'é'.repeat(100)}:0`]?.monthlyTokenLimit).toBe(100);
      expect(await readFile(path, 'utf8')).toBe(raw);
      await expect(
        repo.updateSettings({
          settings: { teams: { 'team:alpha': limit } },
          expectedUpdatedAt: revision,
        } as never)
      ).rejects.toThrow('team identity version');
      expect(await readFile(path, 'utf8')).toBe(raw);
      const saved = await repo.updateSettings({
        teamIdentityVersion: 1,
        settings: { teams: { 'team:team:alpha': limit } },
        expectedUpdatedAt: revision,
      });
      expect(saved.updatedAt).toBe(now().toISOString());
      expect(await new JsonTokenUsageBudgetSettingsRepository(path).getSettings()).toEqual(saved);
    }
  );
  // The create restriction belongs inside the serialized durable CAS boundary.
  it('permits legacy edit/delete, rejects fresh creation and recreation, and decodes orphan names', async () => {
    const path = await file('settings.json');
    const repo = new JsonTokenUsageBudgetSettingsRepository(path, undefined, now);
    await expect(
      repo.updateSettings({
        teamIdentityVersion: 1,
        settings: { teams: { [LEGACY_COMBINED_TEAM_ID]: limit } },
        expectedUpdatedAt: null,
      })
    ).rejects.toThrow('only be edited or deleted');
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        settings: { updatedAt: revision, teams: { unassigned: limit } },
      })
    );
    const previous = await repo.getSettings();
    const edited = await repo.updateSettings({
      teamIdentityVersion: 1,
      settings: { teams: { [LEGACY_COMBINED_TEAM_ID]: { ...limit, monthlyTokenLimit: 200 } } },
      expectedUpdatedAt: previous.updatedAt!,
    });
    expect(edited.teams?.[LEGACY_COMBINED_TEAM_ID]?.monthlyTokenLimit).toBe(200);
    const deleted = await repo.updateSettings({
      teamIdentityVersion: 1,
      settings: {},
      expectedUpdatedAt: edited.updatedAt!,
    });
    await expect(
      repo.updateSettings({
        teamIdentityVersion: 1,
        settings: { teams: { [LEGACY_COMBINED_TEAM_ID]: limit } },
        expectedUpdatedAt: deleted.updatedAt!,
      })
    ).rejects.toThrow('only be edited or deleted');
    expect(await repo.getSettings()).toEqual(deleted);
  });
  // Pruning must rescue expanded raw-name coverage without losing current acceptance.
  it('prunes oversized migrated team coverage while retaining orphan/current dedupe', async () => {
    const path = await file('coverage.json');
    const sent = Object.fromEntries(
      Array.from({ length: 550 }, (_, index) => [
        `old:${index}`,
        { ...coverage(`team:${'é'.repeat(100)}:${index}`), periodKey: '2026-07' },
      ])
    );
    sent.current = coverage('unassigned');
    sent.orphan = coverage('team:orphan');
    const raw = JSON.stringify({ schemaVersion: 1, sent });
    expect(Buffer.byteLength(raw)).toBeLessThan(512 * 1024);
    await writeFile(path, raw);
    const repo = new JsonTokenUsageBudgetNotificationStateRepository(path);
    expect(await repo.hasSent(budgetCoverageKey(coverage(LEGACY_COMBINED_TEAM_ID)))).toBe(true);
    expect(await repo.hasSent(budgetCoverageKey(coverage('team:team:orphan')))).toBe(true);
    await expect(repo.markCovered([])).rejects.toThrow('size limit');
    expect(await readFile(path, 'utf8')).toBe(raw);
    await repo.pruneBeforePeriod('2026-08');
    const restarted = new JsonTokenUsageBudgetNotificationStateRepository(path);
    expect(JSON.parse(await readFile(path, 'utf8')).schemaVersion).toBe(3);
    expect(await restarted.hasSent(budgetCoverageKey(coverage(LEGACY_COMBINED_TEAM_ID, 80)))).toBe(
      true
    );
    expect(await restarted.hasSent(budgetCoverageKey(coverage('team:team:orphan')))).toBe(true);
    expect(
      await restarted.hasSent(
        budgetCoverageKey({ ...coverage(`team:team:${'é'.repeat(100)}:0`), periodKey: '2026-07' })
      )
    ).toBe(false);
  });
});
