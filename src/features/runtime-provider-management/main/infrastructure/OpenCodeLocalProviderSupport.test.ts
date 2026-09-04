import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RUNTIME_LOCAL_PROVIDER_PRESETS } from '../../core/domain';

import {
  buildDeferredProviderListEntry,
  commitProviderConfigWithCredential,
  createProviderApiKeyReference,
  writeProviderApiKeyReference,
} from './OpenCodeLocalProviderSupport';

const CREDENTIAL_REFERENCE_PREFIX = '{file:~/.config/opencode/agent-teams-credentials/';

describe('OpenCodeLocalProviderSupport', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-provider-support-'));
    const projectPath = path.join(tempDir, 'project');
    await fs.mkdir(projectPath);
    configPath = path.join(projectPath, 'opencode.jsonc');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('preserves small-model and private-network state in deferred entries', () => {
    const preset = RUNTIME_LOCAL_PROVIDER_PRESETS.find((candidate) => candidate.id === 'custom');
    if (!preset) throw new Error('Expected the custom provider preset');

    expect(
      buildDeferredProviderListEntry({
        preset,
        providerId: 'remote-compatible',
        baseUrl: 'https://example.com/v1',
        hasConfiguredApiKey: true,
        configuredModelIds: ['large-model', 'small-model'],
        configuredDefaultModelId: 'large-model',
        smallModelId: 'small-model',
        isDefault: true,
        privateNetworkApproved: true,
      })
    ).toMatchObject({
      defaultModelId: 'large-model',
      smallModelId: 'small-model',
      privateNetworkApproved: true,
    });
  });

  it('carries a configured reasoning effort through and stays complete without one', () => {
    const preset = RUNTIME_LOCAL_PROVIDER_PRESETS.find((candidate) => candidate.id === 'custom');
    if (!preset) throw new Error('Expected the custom provider preset');
    const configured = {
      preset,
      providerId: 'remote-compatible',
      baseUrl: 'https://example.com/v1',
      hasConfiguredApiKey: true,
      configuredModelIds: ['large-model'],
      configuredDefaultModelId: 'large-model',
      isDefault: true,
    };

    expect(
      buildDeferredProviderListEntry({
        ...configured,
        configuredModelReasoningEffort: { 'large-model': 'high' },
      })?.configuredModelReasoningEffort
    ).toEqual({ 'large-model': 'high' });
    // The field is optional: a snapshot without one still yields a full entry.
    const withoutReasoningEffort = buildDeferredProviderListEntry(configured);
    expect(withoutReasoningEffort?.configuredModelReasoningEffort).toBeUndefined();
    expect(withoutReasoningEffort).toMatchObject({
      defaultModelId: 'large-model',
      state: 'available',
      liveModels: [{ id: 'large-model', displayName: 'large-model' }],
    });
  });

  it('removes a rotated credential only when its filename proves provider and config ownership', async () => {
    const previousReference = createProviderApiKeyReference({
      configPath,
      providerId: 'owned-provider',
    });
    await stageCredential(previousReference, 'previous-secret');

    await rotateCredential({
      providerId: 'owned-provider',
      previousReference,
    });

    await expect(
      fs.readFile(resolveCredentialPath(previousReference), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a managed credential owned by another provider', async () => {
    const previousReference = createProviderApiKeyReference({
      configPath,
      providerId: 'foreign-provider',
    });
    await stageCredential(previousReference, 'foreign-secret');

    await rotateCredential({
      providerId: 'owned-provider',
      previousReference,
    });

    await expect(fs.readFile(resolveCredentialPath(previousReference), 'utf8')).resolves.toBe(
      'foreign-secret'
    );
  });

  it('preserves a managed credential owned by another config scope', async () => {
    const previousReference = createProviderApiKeyReference({
      configPath: path.join(tempDir, 'other-project', 'opencode.jsonc'),
      providerId: 'owned-provider',
    });
    await stageCredential(previousReference, 'other-scope-secret');

    await rotateCredential({
      providerId: 'owned-provider',
      previousReference,
    });

    await expect(fs.readFile(resolveCredentialPath(previousReference), 'utf8')).resolves.toBe(
      'other-scope-secret'
    );
  });

  it('preserves an owned credential while the committed config still shares its reference', async () => {
    const previousReference = createProviderApiKeyReference({
      configPath,
      providerId: 'owned-provider',
    });
    await stageCredential(previousReference, 'shared-secret');
    const nextReference = createProviderApiKeyReference({
      configPath,
      providerId: 'owned-provider',
    });
    const contents = JSON.stringify({
      provider: {
        'owned-provider': { options: { apiKey: nextReference } },
        'shared-provider': { options: { apiKey: previousReference } },
      },
    });

    await commitProviderConfigWithCredential({
      homePath: tempDir,
      configPath,
      providerId: 'owned-provider',
      apiKey: 'next-secret',
      apiKeyReference: nextReference,
      previousApiKeyReference: previousReference,
      contents,
      mode: 0o600,
    });

    await expect(fs.readFile(resolveCredentialPath(previousReference), 'utf8')).resolves.toBe(
      'shared-secret'
    );
  });

  async function stageCredential(reference: string, apiKey: string): Promise<void> {
    await writeProviderApiKeyReference({
      homePath: tempDir,
      apiKeyReference: reference,
      apiKey,
    });
  }

  async function rotateCredential(input: {
    readonly providerId: string;
    readonly previousReference: string;
  }): Promise<void> {
    const nextReference = createProviderApiKeyReference({
      configPath,
      providerId: input.providerId,
    });
    await commitProviderConfigWithCredential({
      homePath: tempDir,
      configPath,
      providerId: input.providerId,
      apiKey: 'next-secret',
      apiKeyReference: nextReference,
      previousApiKeyReference: input.previousReference,
      contents: JSON.stringify({
        provider: {
          [input.providerId]: { options: { apiKey: nextReference } },
        },
      }),
      mode: 0o600,
    });
  }

  function resolveCredentialPath(reference: string): string {
    const filename = reference.slice(CREDENTIAL_REFERENCE_PREFIX.length, -1);
    return path.join(tempDir, '.config', 'opencode', 'agent-teams-credentials', filename);
  }
});
