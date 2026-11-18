// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ClaudeMultimodelBridgeService } from '@main/services/runtime/ClaudeMultimodelBridgeService';
import { resolveRuntimeProviderStatusCheck } from '@main/services/runtime/providerStatusCheckContract';
import { buildRuntimeProviderLaunchFacts } from '@main/services/team/provisioning/TeamProvisioningLaunchIdentity';
import { resolveProviderCompatibilityModel } from '@main/services/team/provisioning/TeamProvisioningProviderPreflight';
import {
  addModelCatalogLaunchModels,
  validateRuntimeLaunchSelection,
} from '@main/services/team/provisioning/TeamProvisioningRuntimeLaunchSelection';
import { hasEffectiveProviderLaunchAuthority } from '@renderer/utils/providerReadiness';
import {
  getAvailableTeamProviderModelOptions,
  getAvailableTeamProviderModels,
  getTeamModelSelectionError,
  normalizeTeamModelForUi,
} from '@renderer/utils/teamModelAvailability';
import { isProviderModelCatalogExactReady } from '@shared/utils/providerStatusAuthority';
import { describe, expect, it } from 'vitest';

import type { RuntimeProviderLaunchFacts } from '@main/services/team/provisioning/TeamProvisioningRuntimeLaunchSelection';
import type {
  CliProviderId,
  CliProviderModelCatalogSource,
  CliProviderModelCatalogStatus,
  CliProviderStatus,
} from '@shared/types';

interface RuntimeStatusMapper {
  mapRuntimeProviderStatus: (
    providerId: CliProviderId,
    runtimeStatus: unknown
  ) => CliProviderStatus;
}

function mapRuntimeProviderStatus(
  providerId: CliProviderId,
  runtimeStatus: unknown
): CliProviderStatus {
  const service = new ClaudeMultimodelBridgeService() as unknown as RuntimeStatusMapper;
  return service.mapRuntimeProviderStatus(providerId, runtimeStatus);
}

function createRuntimeCatalogModel(
  launchModel: string,
  displayName: string,
  options: {
    isDefault?: boolean;
    hidden?: boolean;
    efforts?: string[];
    badgeLabel?: string | null;
  } = {}
): Record<string, unknown> {
  return {
    id: launchModel,
    launchModel,
    displayName,
    hidden: options.hidden === true,
    supportedReasoningEfforts: options.efforts ?? ['low', 'medium', 'high'],
    defaultReasoningEffort: 'high',
    supportsFastMode: false,
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    isDefault: options.isDefault === true,
    upgrade: false,
    source: 'anthropic-models-api',
    badgeLabel: options.badgeLabel ?? displayName,
    statusMessage: null,
    metadata: {
      context: 1_000_000,
    },
  };
}

function createAnthropicRuntimeStatus(
  models: Record<string, unknown>[],
  options: {
    catalogSource?: CliProviderModelCatalogSource;
    catalogStatus?: CliProviderModelCatalogStatus;
  } = {}
): unknown {
  const catalogSource = options.catalogSource ?? 'anthropic-models-api';
  const catalogStatus = options.catalogStatus ?? 'ready';
  const catalogModels: Record<string, unknown>[] = models.map((model) => ({
    ...model,
    source: catalogSource,
  }));
  const visibleModels = catalogModels
    .filter((model) => model.hidden !== true)
    .map((model) => String(model.launchModel));

  return {
    providerId: 'anthropic',
    supported: true,
    authenticated: true,
    authMethod: 'claude.ai',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    statusCheckErrorCode: undefined,
    statusMessage: null,
    detailMessage: null,
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: {
        plugins: { status: 'supported', ownership: 'shared', reason: null },
        mcp: { status: 'supported', ownership: 'shared', reason: null },
        skills: { status: 'supported', ownership: 'shared', reason: null },
        apiKeys: { status: 'supported', ownership: 'shared', reason: null },
      },
    },
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    backend: null,
    models: visibleModels,
    runtimeCapabilities: {
      modelCatalog: {
        dynamic: true,
        source: catalogSource,
      },
      reasoningEffort: {
        supported: true,
        values: ['low', 'medium', 'high', 'max'],
        configPassthrough: false,
      },
    },
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'anthropic',
      source: catalogSource,
      status: catalogStatus,
      fetchedAt: '2026-08-29T00:00:00.000Z',
      staleAt: '2100-01-01T00:00:00.000Z',
      defaultModelId: catalogModels[0]?.id ?? null,
      defaultLaunchModel: catalogModels[0]?.launchModel ?? null,
      models: catalogModels,
      diagnostics: {
        configReadState: catalogSource === 'static-fallback' ? 'failed' : 'ready',
        appServerState: catalogSource === 'static-fallback' ? 'degraded' : 'healthy',
        message: null,
        code: null,
      },
    },
  };
}

function createLaunchFacts(provider: CliProviderStatus): RuntimeProviderLaunchFacts {
  const modelIds = new Set(provider.models);
  if (provider.modelCatalog) {
    addModelCatalogLaunchModels(modelIds, provider.modelCatalog);
  }

  return {
    defaultModel: provider.modelCatalog?.defaultLaunchModel ?? provider.models[0] ?? null,
    modelIds,
    modelListParsed: true,
    modelCatalog: provider.modelCatalog ?? null,
    runtimeCapabilities: provider.runtimeCapabilities ?? null,
    providerStatus: provider,
  };
}

describe('Anthropic model catalog picker safe e2e', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps the finite legacy peer concrete model through original Main and picker validation',
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-desktop-backend-')));
      try {
        for (const name of ['claude', 'workspace', 'tmp', 'home']) {
          mkdirSync(join(root, name), { mode: 0o700 });
        }
        const peer = resolve('tools/owned-process-broker/fixtures/legacyBootstrapPeer.mjs');
        const env = {
          TEST_LEGACY_BOOTSTRAP: 'current-solo-v1',
          TEST_LEGACY_BOOTSTRAP_ROOT: root,
          TEST_LEGACY_BOOTSTRAP_REPO: root,
          HOME: join(root, 'home'),
          CLAUDE_ROOT: join(root, 'claude'),
          CLAUDE_CONFIG_DIR: join(root, 'claude'),
          TMPDIR: join(root, 'tmp'),
        };
        const metadata = (operation: 'runtime' | 'model') => {
          const result = spawnSync(
            process.execPath,
            [peer, operation, operation === 'runtime' ? 'status' : 'list', '--json', '--provider', 'anthropic',
              ...(operation === 'runtime' ? ['--summary'] : [])],
            { cwd: join(root, 'workspace'), env, encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024 }
          );
          expect(result.error).toBeUndefined();
          expect(result.signal).toBeNull();
          expect(result.status, result.stderr).toBe(0);
          return result.stdout;
        };
        const runtimeStatusStdout = metadata('runtime');
        const modelListStdout = metadata('model');
        const wire = JSON.parse(runtimeStatusStdout).providers.anthropic;
        const provider = mapRuntimeProviderStatus('anthropic', wire);
        const required = {
          selectedBackendId: null, resolvedBackendId: null, availableBackends: [],
          externalRuntimeDiagnostics: [], backend: null, detailMessage: null,
        };
        expect(wire).toMatchObject(required);
        expect(resolveRuntimeProviderStatusCheck(wire, 'anthropic')).toEqual({
          statusCheckOutcome: 'authoritative', statusCheckErrorCode: undefined,
        });
        expect(provider).toMatchObject({
          statusCheckOutcome: 'authoritative', verificationState: 'verified', authenticated: true,
          capabilities: { teamLaunch: true }, modelCatalogRefreshState: 'ready',
          modelCatalog: { status: 'ready' },
        });
        expect(provider.statusCheckErrorCode).toBeUndefined();
        expect(isProviderModelCatalogExactReady(provider)).toBe(true);
        for (const field of Object.keys(required)) {
          const incomplete: Record<string, unknown> = { ...wire };
          delete incomplete[field];
          expect(resolveRuntimeProviderStatusCheck(incomplete, 'anthropic'), field).toEqual({
            statusCheckOutcome: 'pending', statusCheckErrorCode: 'partial_response',
          });
          expect(mapRuntimeProviderStatus('anthropic', incomplete), field).toMatchObject({
            statusCheckOutcome: 'pending', statusCheckErrorCode: 'partial_response',
            verificationState: 'unknown', authenticated: false, capabilities: { teamLaunch: false },
            modelCatalog: { status: 'stale' },
          });
        }
        const options = getAvailableTeamProviderModelOptions('anthropic', provider);
        const sonnet = options.filter((option) => option.label === 'Sonnet 4.6');
        expect(sonnet.map((option) => option.value)).toEqual(['claude-sonnet-4-6']);
        expect(options.map((option) => option.value)).toEqual(['', 'claude-sonnet-4-6']);
        expect(provider.modelCatalog?.diagnostics.message).toContain('Finite TEST');
        expect(provider.modelCatalog?.source).toBe('anthropic-models-api');
        expect(provider.runtimeCapabilities?.modelCatalog?.dynamic).toBe(false);
        const facts = buildRuntimeProviderLaunchFacts({
          providerId: 'anthropic', modelListStdout, runtimeStatusStdout, limitContext: false,
        });
        expect([...facts.modelIds]).toEqual(['claude-sonnet-4-6']);
        const compatibility = (model: string) => resolveProviderCompatibilityModel({
          providerId: 'anthropic', requestedModelId: model, runtimeFacts: facts, limitContext: false,
        });
        expect(compatibility(sonnet[0]!.value)).toEqual({
          kind: 'available', resolvedModelId: 'claude-sonnet-4-6',
        });
        for (const model of ['sonnet', 'claude-TEST-unadvertised']) {
          expect(compatibility(model)).toMatchObject({ kind: 'unavailable' });
          expect(() => validateRuntimeLaunchSelection({
            actorLabel: 'TEST finite source', providerId: 'anthropic', model, facts,
            anthropicFastModeDefault: false, getProviderLabel: () => 'Anthropic',
          })).toThrow('current runtime does not list it as launchable');
        }
        const effects = readFileSync(join(root, 'finite-legacy-peer.ndjson'), 'utf8')
          .trim().split('\n').map((line) => JSON.parse(line));
        expect(effects.map((row) => [row.event, row.operation])).toEqual([
          ['metadata-control', 'runtime'], ['metadata-control', 'model'],
        ]);
        expect(effects[0].args).toEqual(['--json', '--provider', 'anthropic', '--summary']);
        expect(readdirSync(join(root, 'claude'))).toEqual([]);
        expect(readdirSync(join(root, 'workspace'))).toEqual([]);
        expect(readdirSync(join(root, 'tmp'))).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'keeps the retained archive metadata protocol exact through original Main readiness',
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-desktop-backend-')));
      try {
        for (const name of ['claude', 'workspace', 'tmp', 'home']) {
          mkdirSync(join(root, name), { mode: 0o700 });
        }
        const digest = (value: string) => createHash('sha256').update(value).digest('hex');
        const descriptorPath = join(root, 'desktop-descriptor.json');
        const descriptorBytes = '{}';
        writeFileSync(descriptorPath, descriptorBytes, { mode: 0o600, flag: 'wx' });
        const archivePath = join(root, 'retained-original-archive.json');
        const archiveBytes = JSON.stringify({
          version: 1, sourceKind: 'TEST-legacy-archive-without-native-release',
          teamName: 'test-retained-original', workspace: join(root, 'workspace'),
          hostDescriptor: { path: descriptorPath, sha256: digest(descriptorBytes) },
        });
        writeFileSync(archivePath, archiveBytes, { mode: 0o600, flag: 'wx' });
        const settingsPath = join(root, 'private-settings.json');
        writeFileSync(settingsPath, '{}', { mode: 0o600, flag: 'wx' });
        const peer = resolve('tools/owned-process-broker/fixtures/retainedLegacyBootstrapPeer.mjs');
        const env = {
          TEST_RETAINED_BOOTSTRAP: 'archive-solo-v1',
          TEST_RETAINED_BOOTSTRAP_ROOT: root,
          TEST_RETAINED_BOOTSTRAP_REPO: root,
          TEST_RETAINED_BOOTSTRAP_ARCHIVE_SHA256: digest(archiveBytes),
          AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH: descriptorPath,
          AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256: digest(descriptorBytes),
          HOME: join(root, 'home'),
          CLAUDE_ROOT: join(root, 'claude'),
          CLAUDE_CONFIG_DIR: join(root, 'claude'),
          TMPDIR: join(root, 'tmp'),
        };
        const run = (args: string[]) => spawnSync(process.execPath, [peer, ...args], {
          cwd: join(root, 'workspace'), env, encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024,
        });
        const accepted = (args: string[]) => {
          const result = run(args);
          expect(result.error).toBeUndefined();
          expect(result.signal).toBeNull();
          expect(result.status, result.stderr).toBe(0);
          return result.stdout;
        };
        const trailing = ['runtime', 'status', '--json', '--provider', 'anthropic', '--summary'];
        const leading = ['runtime', 'status', '--json', '--summary', '--provider', 'anthropic'];
        const before = Date.now();
        const runtimeStatusStdout = accepted(trailing);
        const after = Date.now();
        const wire = JSON.parse(runtimeStatusStdout).providers.anthropic;
        const provider = mapRuntimeProviderStatus('anthropic', wire);
        const required = {
          selectedBackendId: null, resolvedBackendId: null, availableBackends: [],
          externalRuntimeDiagnostics: [], backend: null, detailMessage: null,
        };
        expect(wire).toMatchObject(required);
        expect(resolveRuntimeProviderStatusCheck(wire, 'anthropic')).toEqual({
          statusCheckOutcome: 'authoritative', statusCheckErrorCode: undefined,
        });
        expect(provider).toMatchObject({
          statusCheckOutcome: 'authoritative', verificationState: 'verified', authenticated: true,
          capabilities: { teamLaunch: true }, modelCatalogRefreshState: 'ready',
          modelCatalog: { status: 'ready', defaultLaunchModel: 'claude-sonnet-4-6' },
        });
        expect(provider.statusCheckErrorCode).toBeUndefined();
        expect(isProviderModelCatalogExactReady(provider)).toBe(true);
        expect(hasEffectiveProviderLaunchAuthority(provider)).toBe(true);
        expect(provider.modelCatalog?.diagnostics.message).toContain('Finite TEST');
        expect(provider.runtimeCapabilities?.modelCatalog?.dynamic).toBe(false);
        expect(provider.runtimeCapabilities?.reasoningEffort).toEqual({
          supported: false, values: [], configPassthrough: false,
        });
        const fetchedAt = Date.parse(wire.modelCatalog.fetchedAt);
        expect(fetchedAt).toBeGreaterThanOrEqual(before);
        expect(fetchedAt).toBeLessThanOrEqual(after);
        expect(Date.parse(wire.modelCatalog.staleAt) - fetchedAt).toBe(60_000);
        for (const args of [leading, ['--settings', settingsPath, ...trailing]]) {
          const status = JSON.parse(accepted(args)).providers.anthropic;
          expect(resolveRuntimeProviderStatusCheck(status, 'anthropic')).toEqual({
            statusCheckOutcome: 'authoritative', statusCheckErrorCode: undefined,
          });
          expect(isProviderModelCatalogExactReady(mapRuntimeProviderStatus('anthropic', status))).toBe(true);
        }
        const modelListStdout = accepted(['model', 'list', '--json', '--provider', 'anthropic']);
        const auth = JSON.parse(accepted(['auth', 'status', '--json', '--provider', 'anthropic']));
        expect(resolveRuntimeProviderStatusCheck(auth.status, 'anthropic')).toEqual({
          statusCheckOutcome: 'authoritative', statusCheckErrorCode: undefined,
        });
        const options = getAvailableTeamProviderModelOptions('anthropic', provider);
        expect(options.map((option) => [option.value, option.label])).toEqual([
          ['', 'Default'], ['claude-sonnet-4-6', 'Sonnet 4.6'],
        ]);
        const facts = buildRuntimeProviderLaunchFacts({
          providerId: 'anthropic', modelListStdout, runtimeStatusStdout, limitContext: false,
        });
        expect([...facts.modelIds]).toEqual(['claude-sonnet-4-6']);
        const compatibility = (model: string) => resolveProviderCompatibilityModel({
          providerId: 'anthropic', requestedModelId: model, runtimeFacts: facts, limitContext: false,
        });
        expect(compatibility('claude-sonnet-4-6')).toEqual({
          kind: 'available', resolvedModelId: 'claude-sonnet-4-6',
        });
        for (const model of ['sonnet', 'claude-TEST-unadvertised']) {
          expect(compatibility(model)).toMatchObject({ kind: 'unavailable' });
          expect(() => validateRuntimeLaunchSelection({
            actorLabel: 'TEST retained archive', providerId: 'anthropic', model, facts,
            anthropicFastModeDefault: false, getProviderLabel: () => 'Anthropic',
          })).toThrow('current runtime does not list it as launchable');
        }
        for (const field of Object.keys(required)) {
          const incomplete: Record<string, unknown> = { ...wire };
          delete incomplete[field];
          expect(resolveRuntimeProviderStatusCheck(incomplete, 'anthropic'), field).toEqual({
            statusCheckOutcome: 'pending', statusCheckErrorCode: 'partial_response',
          });
          expect(mapRuntimeProviderStatus('anthropic', incomplete), field).toMatchObject({
            statusCheckOutcome: 'pending', statusCheckErrorCode: 'partial_response',
            verificationState: 'unknown', authenticated: false, capabilities: { teamLaunch: false },
            modelCatalog: { status: 'stale' },
          });
        }
        const missingCatalog: Record<string, unknown> = { ...wire };
        delete missingCatalog.modelCatalog;
        const missingCatalogStatus = mapRuntimeProviderStatus('anthropic', missingCatalog);
        expect(isProviderModelCatalogExactReady(missingCatalogStatus)).toBe(false);
        expect(hasEffectiveProviderLaunchAuthority(missingCatalogStatus)).toBe(false);
        const expiredCatalog = { ...wire, modelCatalog: {
          ...wire.modelCatalog, staleAt: wire.modelCatalog.fetchedAt,
        } };
        const expiredCatalogStatus = mapRuntimeProviderStatus('anthropic', expiredCatalog);
        expect(isProviderModelCatalogExactReady(expiredCatalogStatus)).toBe(false);
        expect(hasEffectiveProviderLaunchAuthority(expiredCatalogStatus)).toBe(false);
        for (const args of [
          [...leading, '--summary'],
          [...trailing, '--summary'],
          [...trailing, '--provider', 'anthropic'],
          ['runtime', 'status', '--json', '--provider', 'codex', '--summary'],
          ['auth', 'status', '--json', '--provider', 'anthropic', '--summary'],
          ['model', 'list', '--json', '--summary', '--provider', 'anthropic'],
          [...trailing, '--model', 'claude-sonnet-4-6'],
          [...trailing, '--unknown'],
        ]) {
          const result = run(args);
          expect(result.error).toBeUndefined();
          expect(result.signal).toBeNull();
          expect(result.status).not.toBe(0);
          expect(result.stdout).toBe('');
        }
        const effects = readFileSync(join(root, 'finite-retained-peer.ndjson'), 'utf8')
          .trim().split('\n').map((line) => JSON.parse(line));
        expect(effects.map((row) => [row.event, row.operation, row.args])).toEqual([
          ['metadata-control', 'runtime', trailing.slice(2)],
          ['metadata-control', 'runtime', leading.slice(2)],
          ['metadata-control', 'runtime', trailing.slice(2)],
          ['metadata-control', 'model', ['--json', '--provider', 'anthropic']],
          ['metadata-control', 'auth', ['--json', '--provider', 'anthropic']],
        ]);
        expect(readFileSync(archivePath, 'utf8')).toBe(archiveBytes);
        expect(readFileSync(descriptorPath, 'utf8')).toBe(descriptorBytes);
        expect(readFileSync(settingsPath, 'utf8')).toBe('{}');
        for (const name of ['claude', 'workspace', 'tmp', 'home']) {
          expect(readdirSync(join(root, name))).toEqual([]);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000
  );

  it('uses the runtime catalog as the account-scoped picker surface', () => {
    const provider = mapRuntimeProviderStatus(
      'anthropic',
      createAnthropicRuntimeStatus([
        createRuntimeCatalogModel('claude-fable-5', 'Fable 5', {
          isDefault: true,
          efforts: ['low', 'medium', 'high', 'max'],
        }),
        createRuntimeCatalogModel('claude-sonnet-5', 'Sonnet 5'),
      ])
    );

    expect(provider.modelCatalog?.source).toBe('anthropic-models-api');
    expect(provider.modelCatalogRefreshState).toBe('ready');
    expect(getAvailableTeamProviderModels('anthropic', provider)).toEqual([
      'claude-fable-5',
      'claude-sonnet-5',
    ]);
    expect(getAvailableTeamProviderModelOptions('anthropic', provider)).toEqual([
      { value: '', label: 'Default', badgeLabel: 'Default' },
      {
        value: 'claude-fable-5',
        label: 'Fable 5',
        badgeLabel: 'Fable 5',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
      {
        value: 'claude-sonnet-5',
        label: 'Sonnet 5',
        badgeLabel: 'Sonnet 5',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
    ]);
    expect(normalizeTeamModelForUi('anthropic', 'claude-fable-5', provider)).toBe('claude-fable-5');
    expect(normalizeTeamModelForUi('anthropic', 'claude-mythos-5', provider)).toBe('');
    expect(getTeamModelSelectionError('anthropic', 'claude-mythos-5', provider)).toContain(
      'not available for the current Anthropic runtime'
    );
    expect(() =>
      validateRuntimeLaunchSelection({
        actorLabel: 'Member jack',
        providerId: 'anthropic',
        model: 'claude-mythos-5',
        facts: createLaunchFacts(provider),
        anthropicFastModeDefault: false,
        getProviderLabel: () => 'Anthropic',
      })
    ).toThrow('current runtime does not list it as launchable');
  });

  it('launches a curated model when model discovery degraded to static fallback', () => {
    const provider = mapRuntimeProviderStatus(
      'anthropic',
      createAnthropicRuntimeStatus(
        [createRuntimeCatalogModel('sonnet', 'Sonnet 4.6', { isDefault: true })],
        {
          catalogSource: 'static-fallback',
          catalogStatus: 'degraded',
        }
      )
    );
    const launchFacts = createLaunchFacts(provider);

    expect(provider.modelCatalog?.source).toBe('static-fallback');
    expect(launchFacts.modelIds.has('claude-sonnet-5')).toBe(false);
    expect(
      getAvailableTeamProviderModelOptions('anthropic', provider).map((option) => option.value)
    ).toContain('claude-sonnet-5');
    expect(normalizeTeamModelForUi('anthropic', 'claude-sonnet-5', provider)).toBe(
      'claude-sonnet-5'
    );
    expect(() =>
      validateRuntimeLaunchSelection({
        actorLabel: 'Member jack',
        providerId: 'anthropic',
        model: 'claude-sonnet-5',
        facts: launchFacts,
        anthropicFastModeDefault: false,
        getProviderLabel: () => 'Anthropic',
      })
    ).not.toThrow();
  });

  it('makes Mythos selectable only when the runtime catalog reports access', () => {
    const provider = mapRuntimeProviderStatus(
      'anthropic',
      createAnthropicRuntimeStatus([
        createRuntimeCatalogModel('claude-fable-5', 'Fable 5', {
          isDefault: true,
          efforts: ['low', 'medium', 'high', 'max'],
        }),
        createRuntimeCatalogModel('claude-mythos-5', 'Mythos 5', {
          efforts: ['low', 'medium', 'high', 'max'],
        }),
        createRuntimeCatalogModel('claude-sonnet-5', 'Sonnet 5'),
      ])
    );

    expect(getAvailableTeamProviderModels('anthropic', provider)).toEqual([
      'claude-fable-5',
      'claude-mythos-5',
      'claude-sonnet-5',
    ]);
    expect(
      getAvailableTeamProviderModelOptions('anthropic', provider).map((option) => option.value)
    ).toEqual(['', 'claude-fable-5', 'claude-mythos-5', 'claude-sonnet-5']);
    expect(normalizeTeamModelForUi('anthropic', 'claude-mythos-5', provider)).toBe(
      'claude-mythos-5'
    );
    expect(getTeamModelSelectionError('anthropic', 'claude-mythos-5', provider)).toBeNull();
  });
});
