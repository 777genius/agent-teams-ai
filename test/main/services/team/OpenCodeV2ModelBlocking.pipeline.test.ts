// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { projectProviderAuthority } from '@main/services/infrastructure/cliInstallerStatusAuthority';
import { ClaudeMultimodelBridgeService } from '@main/services/runtime/ClaudeMultimodelBridgeService';
import { prepareSelectedOpenCodeModelsForProvisioning } from '@main/services/team/provisioning/TeamProvisioningOpenCodeModelPreparation';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { TeamLaunchRuntimeAdapter } from '@main/services/team/runtime';
import type { CliProviderId, CliProviderStatus } from '@shared/types';

// The bridge service checks project folders; fixture paths are not real folders.
vi.mock('@main/utils/directoryPresence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/utils/directoryPresence')>()),
  isMissingDirectory: () => Promise.resolve(false),
}));

// Renderer modules read localStorage while they load; this suite runs in Node.
const localStorageState = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => localStorageState.get(key) ?? null,
  setItem: (key: string, value: string) => {
    localStorageState.set(key, String(value));
  },
  removeItem: (key: string) => {
    localStorageState.delete(key);
  },
  clear: () => {
    localStorageState.clear();
  },
  key: (index: number) => [...localStorageState.keys()][index] ?? null,
  get length() {
    return localStorageState.size;
  },
});

let createLaunchGuard: typeof import('@renderer/components/team/dialogs/providerLaunchAuthority').createLaunchGuard;
let resolveProjectScopedProviderStatus: typeof import('@renderer/hooks/useEffectiveCliProviderStatus').resolveProjectScopedProviderStatus;

// Loading the renderer store graph in Node can take a while on a busy machine.
beforeAll(async () => {
  ({ createLaunchGuard } =
    await import('@renderer/components/team/dialogs/providerLaunchAuthority'));
  ({ resolveProjectScopedProviderStatus } =
    await import('@renderer/hooks/useEffectiveCliProviderStatus'));
}, 60_000);

const V1_KIMI = 'kimi-for-coding/kimi-for-coding';
const V2_STATUS_TEXT =
  'Authentication, team launch and one-shot execution remain unqualified. Only an existing verified V2 native selection is supported for reads.';
const KIMI_REASON =
  'Kimi Code Membership uses a different provider id in OpenCode V2 ' +
  '(kimi-code-plan-cn / kimi-code-plan-global), so this V1 model id cannot run there. ' +
  'Pick its model under kimi-code-plan-global in the V2 catalog instead.';

/** The `runtime status --json` answer of OpenCode V2 with a ready catalog, as the runtime sends it. */
function readRawV2RuntimeStatus(): { providers: { opencode: Record<string, unknown> } } {
  return JSON.parse(
    readFileSync(path.resolve('test/fixtures/opencode/v2-runtime-status-model-only.json'), 'utf8')
  ) as { providers: { opencode: Record<string, unknown> } };
}

/** What main reads in the preflight: the real runtime status mapper. */
function mapInMain(raw = readRawV2RuntimeStatus()): CliProviderStatus {
  const service = new ClaudeMultimodelBridgeService() as unknown as {
    mapRuntimeProviderStatus: (providerId: CliProviderId, status: unknown) => CliProviderStatus;
  };
  return service.mapRuntimeProviderStatus('opencode', raw.providers.opencode);
}

/** What the launch dialog sees: main projection, then the renderer's project scope. */
function projectToRenderer(mapped: CliProviderStatus): CliProviderStatus {
  const now = Date.now();
  const projected = projectProviderAuthority(mapped, now);
  const resolved = resolveProjectScopedProviderStatus('opencode', projected, null, now);
  if (!resolved) throw new Error('expected a project scoped status');
  return resolved;
}

async function preflight(
  provider: CliProviderStatus,
  modelIds: string[],
  readOpenCodeRuntimeStatus: () => Promise<{
    installed: boolean;
    version?: string;
  }> = async () => ({
    installed: true,
    version: '2.1.4',
  })
) {
  const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>();
  const result = await prepareSelectedOpenCodeModelsForProvisioning({
    adapter: { providerId: 'opencode', prepare } as unknown as TeamLaunchRuntimeAdapter,
    readOpenCodeRuntimeStatus,
    readProviderStatus: async () => provider,
    cwd: '/workspace/project',
    modelIds,
    verificationMode: 'compatibility',
  });
  expect(prepare).not.toHaveBeenCalled();
  return result;
}

describe('OpenCode V2 model blocking on the real status path', () => {
  it('keeps the read diagnostics that the projection does not touch', () => {
    const mapped = mapInMain();
    // The catalog label is sanitized for every model_only status; the block must not use it.
    expect(mapped.statusCheckOutcome).toBe('model_only');
    expect(mapped.modelCatalog?.status).toBe('stale');
    expect(mapped.modelCatalogRefreshState).toBe('error');
    expect(mapped.modelCatalog?.diagnostics).toMatchObject({
      configReadState: 'ready',
      appServerState: 'healthy',
    });
    expect(projectToRenderer(mapped).modelCatalog?.diagnostics).toMatchObject({
      configReadState: 'ready',
      appServerState: 'healthy',
    });
  });

  it('blocks a V1 Kimi id in the preflight and the launch dialog gives the same reason', async () => {
    const mapped = mapInMain();
    const result = await preflight(mapped, [V1_KIMI, 'kimi-code-plan-global/kimi-for-coding']);

    const line = `Selected model ${V1_KIMI} is unavailable. ${KIMI_REASON}`;
    expect(result.blockingMessages).toEqual([line]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        modelId: V1_KIMI,
        severity: 'blocking',
        code: 'model_not_in_v2_catalog',
        message: KIMI_REASON,
      }),
    ]);
    expect(result.details).toContain(
      'Selected model kimi-code-plan-global/kimi-for-coding requires strict deep verification.'
    );

    const blockers = createLaunchGuard(
      ['opencode'],
      new Map([['opencode', projectToRenderer(mapped)]]),
      { selectedModels: [V1_KIMI], scopedStatusBySourceId: new Map(), generation: 'v2' }
    ).blockers(true);
    expect(blockers.map((blocker) => blocker.detail)).toEqual([line]);
  });

  it('blocks every selected model without a deferral when none can run on V2', async () => {
    const result = await preflight(mapInMain(), [V1_KIMI, 'zai-coding-plan/glm-9']);
    expect(result.blockingMessages).toHaveLength(2);
    expect(result.details).toEqual(result.blockingMessages);
    expect(result.warnings).toEqual([]);
  });

  it('does not name a model whose source is an app-managed local provider', () => {
    // The listed V2 model keeps the launch unsettled, so the guard still reports OpenCode.
    const blockers = createLaunchGuard(
      ['opencode'],
      new Map([['opencode', projectToRenderer(mapInMain())]]),
      {
        selectedModels: [V1_KIMI, 'kimi-code-plan-global/kimi-for-coding'],
        scopedStatusBySourceId: new Map(),
        localSourceIds: new Set(['kimi-for-coding']),
        generation: 'v2',
      }
    ).blockers(true);
    expect(blockers.map((blocker) => blocker.detail)).toEqual([V2_STATUS_TEXT]);
  });

  it('keeps the previous deferral and status text for a V1 runtime with the same status', async () => {
    const mapped = mapInMain();
    const result = await preflight(mapped, [V1_KIMI], async () => ({
      installed: true,
      version: '1.17.18',
    }));
    expect(result.blockingMessages).toEqual([]);
    expect(result.details).toEqual([
      `Selected model ${V1_KIMI} requires strict deep verification.`,
    ]);

    const blockers = createLaunchGuard(
      ['opencode'],
      new Map([['opencode', projectToRenderer(mapped)]]),
      { selectedModels: [V1_KIMI], scopedStatusBySourceId: new Map(), generation: 'v1' }
    ).blockers(true);
    expect(blockers.map((blocker) => blocker.detail)).toEqual([V2_STATUS_TEXT]);
  });

  it.each(['failed read', 'empty catalog', 'status error code', 'version unreadable'])(
    'keeps the previous deferral when the V2 status cannot judge (%s)',
    async (kind) => {
      const raw = readRawV2RuntimeStatus();
      const status = raw.providers.opencode;
      const catalog = status.modelCatalog as Record<string, unknown>;
      if (kind === 'failed read') {
        catalog.diagnostics = { configReadState: 'failed', appServerState: 'incompatible' };
      }
      if (kind === 'empty catalog') catalog.models = [];
      if (kind === 'status error code') status.statusCheckErrorCode = 'partial_response';
      const result = await preflight(
        mapInMain(raw),
        [V1_KIMI],
        kind === 'version unreadable'
          ? () => Promise.reject(new Error('version probe failed'))
          : undefined
      );
      expect(result.blockingMessages).toEqual([]);
      expect(result.details).toEqual([
        `Selected model ${V1_KIMI} requires strict deep verification.`,
      ]);
    }
  );

  it('does not read the runtime version for a V1 passive status without a catalog', async () => {
    const raw = readRawV2RuntimeStatus();
    delete raw.providers.opencode.modelCatalog;
    const readRuntime = vi.fn(async () => ({ installed: true, version: '1.17.18' }));
    const result = await preflight(mapInMain(raw), [V1_KIMI], readRuntime);
    expect(result.blockingMessages).toEqual([]);
    expect(readRuntime).not.toHaveBeenCalled();
  });
});
