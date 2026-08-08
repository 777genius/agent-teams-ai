import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  type CanonicalListTeamLifecycleResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
} from '@features/team-lifecycle/contracts';
import {
  createTeamLifecycleReadIpcFeature,
  registerTeamLifecycleReadIpc,
  removeTeamLifecycleReadIpc,
} from '@features/team-lifecycle/main';
import { TEAM_LIST } from '@preload/constants/ipcChannels';
import { parseRevision } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { TeamSummary } from '@shared/types';

const ROOT = resolve(import.meta.dirname, '../../../..');
const ADAPTER_PATH =
  'src/features/team-lifecycle/main/adapters/input/ipc/TeamLifecycleReadIpcAdapter.ts';
const FEATURE_PATH =
  'src/features/team-lifecycle/main/composition/createTeamLifecycleReadIpcFeature.ts';
const ENTRYPOINT_PATH = 'src/features/team-lifecycle/main/index.ts';
const COMPOSITION_PATH = 'src/main/ipc/teamFeatureComposition.ts';
const LEGACY_ADAPTERS_PATH = 'src/main/ipc/teamLegacyAdapters.ts';
const TEAMS_PATH = 'src/main/ipc/teams.ts';
const HANDLERS_PATH = 'src/main/ipc/handlers.ts';

const source = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

describe('orchestrator-ready team lifecycle read IPC boundary', () => {
  it('preserves legacy no-request reads and canonical request envelopes on one channel', async () => {
    const handlers = new Map<string, (event: unknown, request?: unknown) => Promise<unknown>>();
    const ipcMain = {
      handle: vi.fn(
        (channel: string, handler: (event: unknown, request?: unknown) => Promise<unknown>) => {
          handlers.set(channel, handler);
        }
      ),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    };
    const legacyTeams = [
      {
        teamName: 'sandbox-team',
        displayName: 'Sandbox Team',
        description: '',
        memberCount: 0,
        taskCount: 0,
        lastActivity: null,
      },
    ] satisfies TeamSummary[];
    const canonicalResult = {
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'success',
      snapshotRevision: parseRevision(`revision_${'a'.repeat(64)}`),
      items: [],
      nextCursor: null,
    } satisfies CanonicalListTeamLifecycleResult;
    const request = {
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      cursor: null,
      expectedRevision: null,
    };
    const listTeams = vi.fn(() => Promise.resolve(legacyTeams));
    const listTeamLifecycle = vi.fn(() => Promise.resolve(canonicalResult));
    const setCurrent = vi.fn();
    const feature = createTeamLifecycleReadIpcFeature({
      legacy: { listTeams },
      canonical: { listTeamLifecycle },
      operations: { setCurrent },
      clock: { now: () => 100 },
      logger: { error: vi.fn(), warn: vi.fn() },
    });

    registerTeamLifecycleReadIpc(ipcMain, feature);

    const handler = handlers.get(TEAM_LIST);
    expect(handler).toBeDefined();
    await expect(handler!({})).resolves.toEqual({ success: true, data: legacyTeams });
    expect(listTeams).toHaveBeenCalledOnce();
    expect(listTeamLifecycle).not.toHaveBeenCalled();
    expect(setCurrent.mock.calls).toEqual([['team:list'], [null]]);

    await expect(handler!({}, request)).resolves.toEqual({
      success: true,
      data: canonicalResult,
    });
    expect(listTeamLifecycle).toHaveBeenCalledWith(request);
    expect(listTeams).toHaveBeenCalledOnce();
    expect(setCurrent.mock.calls).toEqual([['team:list'], [null]]);

    removeTeamLifecycleReadIpc(ipcMain);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(TEAM_LIST);
    expect(handlers.has(TEAM_LIST)).toBe(false);
  });

  it('contains legacy failures, records slow reads, and always clears operation state', async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const setCurrent = vi.fn();
    const now = vi.fn<() => number>().mockReturnValueOnce(100).mockReturnValueOnce(1_600);
    const feature = createTeamLifecycleReadIpcFeature({
      legacy: {
        listTeams: () => Promise.reject(new Error('legacy list failed')),
      },
      canonical: {
        listTeamLifecycle: () => {
          throw new Error('canonical path must not run');
        },
      },
      operations: { setCurrent },
      clock: { now },
      logger,
    });

    await expect(feature.handle({})).resolves.toEqual({
      success: false,
      error: 'legacy list failed',
    });
    expect(logger.error).toHaveBeenCalledWith('[teams:list] legacy list failed');
    expect(logger.warn).toHaveBeenCalledWith('[teams:list] slow ms=1500');
    expect(setCurrent.mock.calls).toEqual([['team:list'], [null]]);
  });

  it('keeps the adapter internal and composes it only through the public lifecycle main surface', () => {
    const adapterSource = source(ADAPTER_PATH);
    const featureSource = source(FEATURE_PATH);
    const entrypointSource = source(ENTRYPOINT_PATH);
    const compositionSource = source(COMPOSITION_PATH);
    const legacyAdaptersSource = source(LEGACY_ADAPTERS_PATH);
    const teamsSource = source(TEAMS_PATH);
    const handlersSource = source(HANDLERS_PATH);

    expect(adapterSource).toContain("const TEAM_LIST_CHANNEL = 'team:list'");
    expect(adapterSource).toContain('request !== undefined');
    expect(featureSource).toContain('createTeamLifecycleReadIpcAdapter(dependencies)');
    expect(featureSource).toContain('registerTeamLifecycleReadIpcAdapter(ipcMain, feature)');
    expect(featureSource).toContain('removeTeamLifecycleReadIpcAdapter(ipcMain)');
    expect(entrypointSource).toContain("from './composition/createTeamLifecycleReadIpcFeature'");
    expect(entrypointSource).not.toContain(
      "from './adapters/input/ipc/TeamLifecycleReadIpcAdapter'"
    );

    expect(compositionSource).toContain("from '@features/team-lifecycle/main'");
    expect(legacyAdaptersSource).toContain("from '@features/team-lifecycle/main'");
    expect(legacyAdaptersSource).toContain(
      'const lifecycleRead = createTeamLifecycleReadIpcFeature({'
    );
    expect(legacyAdaptersSource).toContain(
      'listTeamLifecycle: (request) => facade.handleListTeamLifecycle(request)'
    );
    expect(compositionSource).toContain('createDesktopTeamLegacyAdapters(dependencies, {');
    expect(compositionSource).toContain(
      'registerTeamLifecycleReadIpc(ipcMain, adapters.lifecycleRead)'
    );
    expect(compositionSource).toContain('removeTeamLifecycleReadIpc(ipcMain)');
    expect(compositionSource).not.toContain('createTeamLifecycleReadIpcFeature');
    expect(compositionSource).not.toContain('listTeamLifecycle:');
    expect(compositionSource).not.toContain('TeamLifecycleReadIpcAdapter');
    expect(legacyAdaptersSource).not.toContain('TeamLifecycleReadIpcAdapter');
    expect(teamsSource).not.toContain('TEAM_LIST');
    expect(teamsSource).not.toMatch(/ipcMain\.(?:handle|removeHandler)\(/);
    expect(handlersSource).not.toMatch(
      /TeamLifecycleReadIpc|createTeamLifecycleReadIpcFeature|registerTeamLifecycleReadIpc/
    );

    for (const productionSource of [
      adapterSource,
      featureSource,
      compositionSource,
      legacyAdaptersSource,
      teamsSource,
    ]) {
      expect(productionSource).not.toMatch(/createTeamLifecycleCommandFeature\s*\(/);
      expect(productionSource).not.toMatch(
        /@features\/team-runtime-control|process-supervision|process-recovery|provider-execution/
      );
      expect(productionSource).not.toMatch(/node:child_process|\bspawn\s*\(/);
    }
  });
});
