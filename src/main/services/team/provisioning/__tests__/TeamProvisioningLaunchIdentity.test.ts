import { describe, expect, it, vi } from 'vitest';

import {
  buildDirectMemberLaunchIdentityRequest,
  buildRuntimeProviderLaunchFacts,
  type LaunchIdentityResolutionPorts,
  readRuntimeProviderLaunchFacts,
  type ReadRuntimeProviderLaunchFactsInput,
  type ReadRuntimeProviderLaunchFactsPorts,
  resolveAndValidateLaunchIdentity,
  resolveDirectMemberLaunchIdentity,
} from '../TeamProvisioningLaunchIdentity';

import type { RuntimeProviderLaunchFacts } from '../TeamProvisioningRuntimeLaunchSelection';
import type { CliProviderModelCatalog, ProviderModelLaunchIdentity } from '@shared/types';

function buildCatalog(overrides: Partial<CliProviderModelCatalog> = {}): CliProviderModelCatalog {
  return {
    schemaVersion: 1,
    providerId: 'codex',
    source: 'app-server',
    status: 'ready',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    staleAt: '2026-01-01T01:00:00.000Z',
    defaultModelId: 'catalog-model',
    defaultLaunchModel: 'catalog-launch',
    models: [
      {
        id: 'catalog-model',
        launchModel: 'catalog-launch',
        displayName: 'Catalog Model',
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        inputModalities: [],
        supportsPersonality: false,
        isDefault: true,
        upgrade: false,
        source: 'app-server',
      },
    ],
    diagnostics: {
      configReadState: 'ready',
      appServerState: 'healthy',
    },
    ...overrides,
  };
}

function buildFacts(
  overrides: Partial<RuntimeProviderLaunchFacts> = {}
): RuntimeProviderLaunchFacts {
  return {
    defaultModel: 'default-model',
    modelIds: new Set(['default-model']),
    modelListParsed: true,
    modelCatalog: null,
    runtimeCapabilities: null,
    providerStatus: null,
    ...overrides,
  };
}

function buildLaunchIdentity(
  overrides: Partial<ProviderModelLaunchIdentity> = {}
): ProviderModelLaunchIdentity {
  return {
    providerId: 'codex',
    providerBackendId: null,
    selectedModel: null,
    selectedModelKind: 'default',
    resolvedLaunchModel: 'default-model',
    catalogId: 'default-model',
    catalogSource: 'runtime',
    catalogFetchedAt: null,
    selectedEffort: null,
    resolvedEffort: null,
    ...overrides,
  };
}

describe('team provisioning launch identity facts', () => {
  it('builds runtime launch facts from model list and status catalog output', () => {
    const catalog = buildCatalog();

    const facts = buildRuntimeProviderLaunchFacts({
      providerId: 'codex',
      modelListStdout: JSON.stringify({
        providers: {
          codex: {
            defaultModel: ' model-list-default ',
            models: ['model-list-default', { id: 'listed-model' }],
          },
        },
      }),
      runtimeStatusStdout: JSON.stringify({
        providers: {
          codex: {
            authenticated: true,
            runtimeCapabilities: { modelCatalog: { dynamic: false } },
            modelCatalog: catalog,
          },
        },
      }),
    });

    expect(facts.defaultModel).toBe('catalog-launch');
    expect([...facts.modelIds].sort()).toEqual([
      'catalog-launch',
      'catalog-model',
      'listed-model',
      'model-list-default',
    ]);
    expect(facts.modelListParsed).toBe(true);
    expect(facts.runtimeCapabilities).toEqual({ modelCatalog: { dynamic: false } });
    expect(facts.providerStatus?.providerId).toBe('codex');
    expect(facts.modelCatalog).toStrictEqual(catalog);
  });

  it('keeps parsed model-list facts when runtime status output is malformed', () => {
    const warnings: string[] = [];

    const facts = buildRuntimeProviderLaunchFacts({
      providerId: 'gemini',
      modelListStdout: JSON.stringify({
        providers: {
          gemini: {
            defaultModel: 'gemini-default',
            models: ['gemini-default'],
          },
        },
      }),
      runtimeStatusStdout: 'not json',
      warn: (message) => warnings.push(message),
    });

    expect(facts.defaultModel).toBe('gemini-default');
    expect(facts.modelIds).toEqual(new Set(['gemini-default']));
    expect(facts.providerStatus).toBeNull();
    expect(warnings).toEqual([
      '[gemini] Failed to parse runtime capabilities for launch validation: No JSON object found in CLI output',
    ]);
  });

  it('treats blank runtime fact output as unavailable without warnings', () => {
    const warnings: string[] = [];

    const facts = buildRuntimeProviderLaunchFacts({
      providerId: 'anthropic',
      modelListStdout: '  \n',
      runtimeStatusStdout: '',
      warn: (message) => warnings.push(message),
    });

    expect(facts.modelIds).toEqual(new Set());
    expect(facts.modelListParsed).toBe(false);
    expect(facts.modelCatalog).toBeNull();
    expect(facts.runtimeCapabilities).toBeNull();
    expect(facts.providerStatus).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('augments dynamic Codex launch facts with the app-server catalog', async () => {
    const catalog = buildCatalog();
    const warnings: string[] = [];
    const execCli: ReadRuntimeProviderLaunchFactsPorts['execCli'] = vi.fn(
      async (_binaryPath: string | null, args: string[]) => {
        if (args.includes('model')) {
          return { stdout: 'not json', stderr: '' };
        }
        return {
          stdout: JSON.stringify({
            providers: {
              codex: {
                runtimeCapabilities: { modelCatalog: { dynamic: true } },
              },
            },
          }),
          stderr: '',
        };
      }
    );
    const getCodexModelCatalog = vi.fn(async () => catalog);

    const facts = await readRuntimeProviderLaunchFacts(
      {
        claudePath: '/bin/claude',
        cwd: '/repo',
        providerId: 'codex',
        env: { PATH: '/bin' },
        providerArgs: ['--provider-arg'],
      },
      {
        execCli,
        getCodexModelCatalog,
        warn: (message) => warnings.push(message),
      }
    );

    expect(execCli).toHaveBeenCalledTimes(2);
    expect(execCli).toHaveBeenNthCalledWith(
      1,
      '/bin/claude',
      ['--provider-arg', 'model', 'list', '--json', '--provider', 'codex'],
      expect.objectContaining({ cwd: '/repo', env: { PATH: '/bin' } })
    );
    expect(getCodexModelCatalog).toHaveBeenCalledWith({ cwd: '/repo' });
    expect(facts.defaultModel).toBe('catalog-launch');
    expect(facts.modelIds).toEqual(new Set(['catalog-launch', 'catalog-model']));
    expect(warnings).toEqual([
      '[codex] Failed to parse runtime model list for launch validation: No JSON object found in CLI output',
    ]);
  });
});

describe('team provisioning launch identity request shaping', () => {
  it('builds direct member requests with only launch-significant fields', () => {
    expect(
      buildDirectMemberLaunchIdentityRequest({
        providerId: 'codex',
        providerBackendId: 'codex-native',
        memberSpec: {
          name: 'Worker',
          model: 'gpt-5',
          effort: 'max',
          fastMode: 'off',
        },
        requestLimitContext: false,
      })
    ).toEqual({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5',
      effort: 'max',
      fastMode: 'off',
    });

    expect(
      buildDirectMemberLaunchIdentityRequest({
        providerId: 'anthropic',
        memberSpec: { name: 'Worker' },
        requestLimitContext: true,
      })
    ).toEqual({
      providerId: 'anthropic',
      limitContext: true,
    });
  });
});

describe('team provisioning launch identity resolution', () => {
  it('caches runtime facts by provider while validating lead and members', async () => {
    const codexFacts = buildFacts({ defaultModel: 'codex-default' });
    const anthropicFacts = buildFacts({ defaultModel: 'sonnet' });
    const readRuntimeProviderLaunchFacts = vi.fn(
      async (input: ReadRuntimeProviderLaunchFactsInput) =>
        input.providerId === 'codex' ? codexFacts : anthropicFacts
    );
    const validateRuntimeLaunchSelection = vi.fn();
    const buildProviderModelLaunchIdentity = vi.fn(() =>
      buildLaunchIdentity({ providerId: 'codex', resolvedLaunchModel: 'codex-default' })
    );
    const ports: LaunchIdentityResolutionPorts = {
      readRuntimeProviderLaunchFacts,
      validateRuntimeLaunchSelection,
      buildProviderModelLaunchIdentity,
    };

    const identity = await resolveAndValidateLaunchIdentity(
      {
        claudePath: '/bin/claude',
        cwd: '/repo',
        env: { PATH: '/bin' },
        request: { providerId: 'codex', model: 'gpt-5', effort: 'high', fastMode: 'on' },
        effectiveMembers: [
          { name: 'CodexPeer', providerId: 'codex', model: 'gpt-5-mini' },
          { name: 'ClaudePeer', providerId: 'anthropic', model: 'sonnet' },
        ],
        providerArgsByProvider: new Map([
          ['codex', ['--codex-arg']],
          ['anthropic', ['--anthropic-arg']],
        ]),
      },
      ports
    );

    expect(identity.resolvedLaunchModel).toBe('codex-default');
    expect(readRuntimeProviderLaunchFacts).toHaveBeenCalledTimes(2);
    expect(readRuntimeProviderLaunchFacts).toHaveBeenNthCalledWith(1, {
      claudePath: '/bin/claude',
      cwd: '/repo',
      providerId: 'codex',
      env: { PATH: '/bin' },
      providerArgs: ['--codex-arg'],
      limitContext: undefined,
    });
    expect(readRuntimeProviderLaunchFacts).toHaveBeenNthCalledWith(2, {
      claudePath: '/bin/claude',
      cwd: '/repo',
      providerId: 'anthropic',
      env: { PATH: '/bin' },
      providerArgs: ['--anthropic-arg'],
      limitContext: undefined,
    });
    expect(validateRuntimeLaunchSelection).toHaveBeenCalledTimes(3);
    expect(validateRuntimeLaunchSelection).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        actorLabel: 'Team lead',
        providerId: 'codex',
        model: 'gpt-5',
        effort: 'high',
        fastMode: 'on',
        facts: codexFacts,
      })
    );
    expect(validateRuntimeLaunchSelection).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        actorLabel: 'Member ClaudePeer',
        providerId: 'anthropic',
        model: 'sonnet',
        facts: anthropicFacts,
      })
    );
    expect(buildProviderModelLaunchIdentity).toHaveBeenCalledWith({
      request: { providerId: 'codex', model: 'gpt-5', effort: 'high', fastMode: 'on' },
      facts: codexFacts,
    });
  });

  it('propagates invalid member launch selections before building the lead identity', async () => {
    const facts = buildFacts();
    const readRuntimeProviderLaunchFacts = vi.fn(async () => facts);
    const validateRuntimeLaunchSelection = vi.fn(
      (params: Parameters<LaunchIdentityResolutionPorts['validateRuntimeLaunchSelection']>[0]) => {
        if (params.actorLabel === 'Member BadModel') {
          throw new Error('Member BadModel uses an unsupported launch model');
        }
      }
    );
    const buildProviderModelLaunchIdentity = vi.fn(() => buildLaunchIdentity());
    const ports: LaunchIdentityResolutionPorts = {
      readRuntimeProviderLaunchFacts,
      validateRuntimeLaunchSelection,
      buildProviderModelLaunchIdentity,
    };

    await expect(
      resolveAndValidateLaunchIdentity(
        {
          claudePath: '/bin/claude',
          cwd: '/repo',
          env: { PATH: '/bin' },
          request: { providerId: 'codex', model: 'gpt-5' },
          effectiveMembers: [{ name: 'BadModel', providerId: 'codex', model: 'unknown-model' }],
        },
        ports
      )
    ).rejects.toThrow('Member BadModel uses an unsupported launch model');

    expect(readRuntimeProviderLaunchFacts).toHaveBeenCalledTimes(1);
    expect(validateRuntimeLaunchSelection).toHaveBeenCalledTimes(2);
    expect(buildProviderModelLaunchIdentity).not.toHaveBeenCalled();
  });

  it('resolves direct member launch identity from member-scoped launch fields', async () => {
    const facts = buildFacts({ defaultModel: 'codex-default' });
    const identity = buildLaunchIdentity({ resolvedLaunchModel: 'codex-default' });
    const ports: LaunchIdentityResolutionPorts = {
      readRuntimeProviderLaunchFacts: vi.fn(async () => facts),
      validateRuntimeLaunchSelection: vi.fn(),
      buildProviderModelLaunchIdentity: vi.fn(() => identity),
    };

    await expect(
      resolveDirectMemberLaunchIdentity(
        {
          claudePath: '/bin/claude',
          cwd: '/repo',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          provisioningEnv: {
            env: { PATH: '/bin' },
            providerArgs: ['--provider'],
          },
          memberSpec: {
            name: 'Worker',
            model: 'gpt-5',
            effort: 'max',
            fastMode: 'off',
          },
          requestLimitContext: true,
        },
        ports
      )
    ).resolves.toBe(identity);

    expect(ports.readRuntimeProviderLaunchFacts).toHaveBeenCalledWith({
      claudePath: '/bin/claude',
      cwd: '/repo',
      providerId: 'codex',
      env: { PATH: '/bin' },
      providerArgs: ['--provider'],
      limitContext: true,
    });
    expect(ports.validateRuntimeLaunchSelection).toHaveBeenCalledWith({
      actorLabel: 'Member Worker',
      providerId: 'codex',
      model: 'gpt-5',
      effort: 'max',
      fastMode: 'off',
      limitContext: true,
      facts,
    });
    expect(ports.buildProviderModelLaunchIdentity).toHaveBeenCalledWith({
      request: {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5',
        effort: 'max',
        fastMode: 'off',
        limitContext: true,
      },
      facts,
    });
  });
});
