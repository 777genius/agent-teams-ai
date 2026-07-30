import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { atomicCreateAsync, atomicWriteAsync } from '@main/utils/atomicWrite';
import { findNodeAtLocation, type Node as JsoncNode } from 'jsonc-parser';

import {
  isRuntimeLocalProviderLoopbackUrl,
  RUNTIME_LOCAL_PROVIDER_PRESETS,
  RuntimeLocalProviderValidationError,
} from '../../core/domain';

import type {
  RuntimeLocalProviderErrorCodeDto,
  RuntimeLocalProviderListEntryDto,
  RuntimeLocalProviderPresetDto,
} from '../../contracts';

const MAX_API_KEY_LENGTH = 8_192;
const PROVIDER_CREDENTIAL_DIRECTORY_SEGMENTS = [
  '.config',
  'opencode',
  'agent-teams-credentials',
] as const;
const PROVIDER_CREDENTIAL_REFERENCE_PREFIX = `{file:~/${PROVIDER_CREDENTIAL_DIRECTORY_SEGMENTS.join('/')}/`;
const PROVIDER_CREDENTIAL_SCOPE_HASH_LENGTH = 16;
const PROVIDER_CREDENTIAL_ROTATION_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

interface ConfiguredProviderSnapshot {
  readonly preset: RuntimeLocalProviderPresetDto;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly hasConfiguredApiKey: boolean;
  readonly configuredModelIds: readonly string[];
  readonly configuredDefaultModelId: string | null;
  readonly smallModelId?: string | null;
  readonly isDefault: boolean;
  readonly privateNetworkApproved?: boolean;
}

export class LocalProviderOperationError extends Error {
  constructor(
    readonly code: RuntimeLocalProviderErrorCodeDto,
    message: string,
    readonly recoverable = true
  ) {
    super(message);
    this.name = 'LocalProviderOperationError';
  }
}

export function normalizeOptionalProviderApiKey(value: string | null | undefined): string | null {
  const apiKey = value?.trim() ?? '';
  if (!apiKey) return null;
  const containsInvalidCharacter = [...apiKey].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint === 0 || codePoint === 10 || codePoint === 13;
  });
  if (apiKey.length > MAX_API_KEY_LENGTH || containsInvalidCharacter) {
    throw new RuntimeLocalProviderValidationError('API key is invalid.');
  }
  return apiKey;
}

export function resolveConfiguredProviderPreset(
  providerId: string,
  baseUrl: string
): RuntimeLocalProviderPresetDto | undefined {
  const customPreset = RUNTIME_LOCAL_PROVIDER_PRESETS.find(
    (candidate) => candidate.id === 'custom'
  );
  if (!isRuntimeLocalProviderLoopbackUrl(baseUrl)) return customPreset;
  return (
    RUNTIME_LOCAL_PROVIDER_PRESETS.find((candidate) => candidate.providerId === providerId) ??
    customPreset
  );
}

export function buildDeferredProviderListEntry(
  configured: ConfiguredProviderSnapshot
): RuntimeLocalProviderListEntryDto | null {
  const remote = !isRuntimeLocalProviderLoopbackUrl(configured.baseUrl);
  if (!remote && !configured.hasConfiguredApiKey) return null;
  const configuredModels = configured.configuredModelIds.map((modelId) => ({
    id: modelId,
    displayName: modelId,
  }));
  return {
    preset: configured.preset,
    providerId: configured.providerId,
    baseUrl: configured.baseUrl,
    hasConfiguredApiKey: configured.hasConfiguredApiKey,
    configuredModelIds: configured.configuredModelIds,
    defaultModelId: configured.configuredDefaultModelId ?? configured.configuredModelIds[0] ?? null,
    smallModelId: configured.smallModelId,
    isDefault: configured.isDefault,
    privateNetworkApproved: configured.privateNetworkApproved,
    state: 'available',
    liveModels: configuredModels,
    latencyMs: null,
    message: `${remote ? 'Remote endpoint' : 'Credential-backed endpoint'} configured. OpenCode verifies connectivity and authentication before launch.`,
  };
}

export function createProviderApiKeyReference(input: {
  readonly configPath: string;
  readonly providerId: string;
}): string {
  const filename = `${buildProviderCredentialScope(input)}-${randomUUID()}.key`;
  return `${PROVIDER_CREDENTIAL_REFERENCE_PREFIX}${filename}}`;
}

export function readStringNode(node: JsoncNode | undefined): string | null {
  return node?.type === 'string' && typeof node.value === 'string' ? node.value : null;
}

export function assertProviderApiKeyReplacement(
  configTree: JsoncNode,
  input: { readonly providerId: string; readonly apiKey: string | null }
): string | null {
  const existingApiKey = readStringNode(
    findNodeAtLocation(configTree, ['provider', input.providerId, 'options', 'apiKey'])
  );
  if (!input.apiKey && existingApiKey?.trim()) {
    throw new LocalProviderOperationError(
      'config-conflict',
      'Enter a replacement API key before changing an existing protected provider.'
    );
  }
  return existingApiKey;
}

export async function writeProviderApiKeyReference(input: {
  readonly homePath: string;
  readonly apiKeyReference: string;
  readonly apiKey: string;
}): Promise<{ credentialDirectory: string; credentialPath: string }> {
  let realHomePath: string;
  try {
    const homeStat = await fs.stat(input.homePath);
    if (!homeStat.isDirectory()) throw new Error('not-directory');
    realHomePath = await fs.realpath(input.homePath);
  } catch {
    throw new LocalProviderOperationError(
      'write-failed',
      'The user home directory is not available for provider credential storage.'
    );
  }

  let credentialDirectory = realHomePath;
  for (const segment of PROVIDER_CREDENTIAL_DIRECTORY_SEGMENTS) {
    credentialDirectory = path.join(credentialDirectory, segment);
    try {
      const stat = await fs.lstat(credentialDirectory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new LocalProviderOperationError(
          'config-conflict',
          'The provider credential directory must be a regular directory.'
        );
      }
    } catch (error) {
      if (error instanceof LocalProviderOperationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new LocalProviderOperationError(
          'write-failed',
          'Could not inspect the provider credential directory.'
        );
      }
      await fs.mkdir(credentialDirectory, { mode: 0o700 });
    }
  }

  const realCredentialDirectory = await fs.realpath(credentialDirectory);
  if (!isPathInside(realHomePath, realCredentialDirectory)) {
    throw new LocalProviderOperationError(
      'config-conflict',
      'The provider credential directory resolves outside the user home directory.'
    );
  }
  if (process.platform !== 'win32') {
    await fs.chmod(realCredentialDirectory, 0o700);
  }

  const filename = parseProviderApiKeyFilename(input.apiKeyReference);
  if (!filename) {
    throw new LocalProviderOperationError(
      'config-conflict',
      'The provider credential reference is invalid.'
    );
  }
  const credentialPath = path.join(realCredentialDirectory, filename);
  await atomicCreateAsync(credentialPath, input.apiKey, { mode: 0o600 });
  return { credentialDirectory: realCredentialDirectory, credentialPath };
}

export async function commitProviderConfigWithCredential(input: {
  readonly homePath: string;
  readonly configPath: string;
  readonly providerId: string;
  readonly apiKey: string | null;
  readonly apiKeyReference: string | null;
  readonly previousApiKeyReference: string | null;
  readonly contents: string;
  readonly mode: number;
}): Promise<void> {
  const commitConfig = (): Promise<void> =>
    atomicWriteAsync(input.configPath, input.contents, { mode: input.mode });
  if (!input.apiKey || !input.apiKeyReference) {
    await commitConfig();
    return;
  }
  const staged = await writeProviderApiKeyReference({
    homePath: input.homePath,
    apiKeyReference: input.apiKeyReference,
    apiKey: input.apiKey,
  });
  try {
    await commitConfig();
  } catch (error) {
    await fs.unlink(staged.credentialPath).catch(() => undefined);
    throw error;
  }
  if (input.previousApiKeyReference && input.previousApiKeyReference !== input.apiKeyReference) {
    if (input.contents.includes(input.previousApiKeyReference)) return;
    await removeManagedProviderCredential(
      staged.credentialDirectory,
      input.previousApiKeyReference,
      {
        configPath: input.configPath,
        providerId: input.providerId,
      }
    ).catch(() => undefined);
  }
}

function buildProviderCredentialScope(input: {
  readonly configPath: string;
  readonly providerId: string;
}): string {
  const scopeHash = createHash('sha256')
    .update(path.resolve(input.configPath))
    .digest('hex')
    .slice(0, PROVIDER_CREDENTIAL_SCOPE_HASH_LENGTH);
  return `${input.providerId}-${scopeHash}`;
}

function parseProviderApiKeyFilename(reference: string): string | null {
  if (!reference.startsWith(PROVIDER_CREDENTIAL_REFERENCE_PREFIX) || !reference.endsWith('}')) {
    return null;
  }
  const filename = reference.slice(PROVIDER_CREDENTIAL_REFERENCE_PREFIX.length, -1);
  return /^[a-z0-9][a-z0-9._-]{0,190}\.key$/i.test(filename) ? filename : null;
}

async function removeManagedProviderCredential(
  credentialDirectory: string,
  reference: string,
  owner: {
    readonly configPath: string;
    readonly providerId: string;
  }
): Promise<void> {
  const filename = parseProviderApiKeyFilename(reference);
  if (!filename || !isOwnedProviderApiKeyFilename(filename, owner)) return;
  const credentialPath = path.join(credentialDirectory, filename);
  const stat = await fs.lstat(credentialPath);
  if (!stat.isSymbolicLink() && stat.isFile()) await fs.unlink(credentialPath);
}

function isOwnedProviderApiKeyFilename(
  filename: string,
  owner: {
    readonly configPath: string;
    readonly providerId: string;
  }
): boolean {
  const scope = buildProviderCredentialScope(owner);
  if (filename === `${scope}.key`) return true;
  const rotationPrefix = `${scope}-`;
  if (!filename.startsWith(rotationPrefix) || !filename.endsWith('.key')) return false;
  const rotationId = filename.slice(rotationPrefix.length, -'.key'.length);
  return PROVIDER_CREDENTIAL_ROTATION_ID_PATTERN.test(rotationId);
}

export function isPathInside(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  );
}
