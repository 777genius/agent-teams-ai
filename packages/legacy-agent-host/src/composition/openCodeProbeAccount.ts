import { captureOpenCodeConfigurationSource } from '../adapters/providers/OpenCodeConfigurationSource.js';
import { captureOpenCodeReadinessOrigin } from '../adapters/providers/OpenCodeReadinessOrigin.js';
import { captureOpenCodeV2Configuration } from '../adapters/providers/OpenCodeV2CapturedConfiguration.js';
import { OpenCodeV2CredentialScope } from '../adapters/providers/OpenCodeV2CredentialScope.js';
import { AcceptedOpenCodeV2FileKey } from '../adapters/providers/OpenCodeV2SelectedFileKey.js';
import type { DeferredOpenCodeV2FileKey } from '../adapters/providers/OpenCodeV2SelectedFileKey.js';
import { ManagementCommandError } from '../management/commandRecords.js';
import { nativeLocalReadinessPurpose } from '../management/ModelProbeOwner.js';
import { managementDigest, managementValuesEqual } from '../management/identity.js';
import { assertOpenCodeV2NativeModel } from './openCodeV2ModelSelection.js';
import type { ModelProbeInput } from '../management/ModelProbeOwner.js';
import type { StoredModelProbe } from '../management/commandRecords.js';
import type { OpenCodeManagementProfile } from '../management/profile.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';

export interface PreparedModelFileKey {
  readonly commandId: string;
  readonly context: string;
  readonly proof: AcceptedOpenCodeV2FileKey;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function held(): never { throw new ManagementCommandError('held'); }

function openCodeModelId(providerId: string, modelId: string): string {
  return modelId.startsWith(providerId + '/') ? modelId.slice(providerId.length + 1) : modelId;
}

/** The original URL classifier's loopback branch only; no DNS, metadata or network observation. */
function loopback(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    return false;
  let hostname = url.hostname.toLowerCase().replace(/(?:^\[|\]$)/g, '');
  if (hostname.includes(':')) {
    const mapped = /^\[::ffff:([a-f0-9]+):([a-f0-9]+)\]$/.exec(new URL('https://[' + hostname + ']').hostname);
    if (mapped) {
      const high = Number.parseInt(mapped[1]!, 16), low = Number.parseInt(mapped[2]!, 16);
      hostname = [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
    }
  }
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)?.slice(1).map(Number);
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' ||
    !!octets?.every(value => value <= 255) && octets[0] === 127;
}

/** Existing private configuration/key readers only. No native allocation or inference. */
export function captureOpenCodeProbeAccount(
  profile: OpenCodeManagementProfile,
  input: Pick<ModelProbeInput, 'providerId' | 'modelId'>,
  ownerCurrent: () => boolean,
  original?: Readonly<StoredModelProbe>,
  capturedOrigin = original?.localModelReadinessOrigin,
  preparedFileKey?: PreparedModelFileKey
): { digest: string; isCurrent(): boolean; nativeCredentialScopeDigest?: string } | undefined {
  return captureOpenCodeProbeAccountInspection(profile, input, ownerCurrent, original, capturedOrigin,
    undefined, preparedFileKey)?.account;
}

/** The same synchronous account inspection also owns its freshly captured policy inspector. */
export function captureOpenCodeProbeAccountInspection(
  profile: OpenCodeManagementProfile,
  input: Pick<ModelProbeInput, 'providerId' | 'modelId'>,
  ownerCurrent: () => boolean,
  original?: Readonly<StoredModelProbe>,
  capturedOrigin = original?.localModelReadinessOrigin,
  memberTarget?: () => ReturnType<ProviderManagementCoordinator['readinessTarget']>,
  preparedFileKey?: PreparedModelFileKey,
  prepareFile?: (source: DeferredOpenCodeV2FileKey, assertOriginal: () => void) => void
): {
  account: NonNullable<ReturnType<typeof captureOpenCodeProbeAccount>>;
  origin: ReturnType<typeof captureOpenCodeReadinessOrigin> | undefined;
  memberReference?: {
    target: ReturnType<ProviderManagementCoordinator['readinessTarget']>;
    originCurrent: boolean; accountDigest: string;
  };
} | undefined {
  if (profile.nativeGeneration === 'v2') assertOpenCodeV2NativeModel(profile, input);
  // The original declaration is only a hint; the complete source observation below
  // must confirm it before grouping this private, synchronous, read-only inspection.
  const workspace = memberTarget && capturedOrigin?.workspaces.find(row => row.path === profile.cwd);
  const declared = workspace && ((!workspace.project.invalid &&
    workspace.project.providers.find(row => row.providerId === input.providerId)) ||
    (!('notConsulted' in workspace.global) &&
      workspace.global.providers.find(row => row.providerId === input.providerId)));
  const bracket = memberTarget !== undefined && profile.nativeGeneration !== 'v2' &&
    original !== undefined && original.nativeFileKeyWitness === undefined &&
    !!declared && declared.hasConfiguredApiKey === true;
  const before = bracket && capturedOrigin
    ? captureOpenCodeReadinessOrigin(capturedOrigin, profile, input.providerId, ownerCurrent) : undefined;
  if (bracket && before?.policy?.hasConfiguredApiKey !== true) held();
  const resolve = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    if (value.includes('{file:')) return held();
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu,
      (_match: string, braced: string | undefined, shell: string | undefined) => {
        const selected = profile.environment[braced ?? shell!];
        if (selected === undefined || selected.includes('\0')) return held();
        return selected;
      });
  };
  let capturedConfig: Record<string, unknown> | undefined, capturedConfiguredKey: unknown;
  const source = captureOpenCodeConfigurationSource(profile,
    profile.nativeGeneration === 'v2' ? profile.embedded?.configurationSource : undefined, ownerCurrent, undefined,
    bracket ? value => {
      capturedConfig = value;
      const provider = object(value.provider) ? value.provider[input.providerId] : undefined;
      const apiKey = object(provider) && object(provider.options) ? provider.options.apiKey : undefined;
      capturedConfiguredKey = typeof apiKey === 'string' && apiKey.includes('{file:') ? apiKey : resolve(apiKey);
    } : undefined);
  const policy = before ?? (capturedOrigin
    ? captureOpenCodeReadinessOrigin(capturedOrigin, profile, input.providerId, ownerCurrent) : undefined);
  const raw = bracket ? capturedConfig ?? held() : source.read();
  const provider = object(raw.provider) ? raw.provider[input.providerId] : undefined;
  const options = object(provider) && object(provider.options) ? provider.options : {};
  const configuredKey = bracket ? capturedConfiguredKey : ((policy || profile.nativeGeneration === 'v2') &&
    typeof options.apiKey === 'string' && options.apiKey.includes('{file:') ? options.apiKey : resolve(options.apiKey));
  const selectedUrl = policy ? policy.policy?.baseUrl
    : object(provider) && provider.npm === '@ai-sdk/openai-compatible' ? resolve(options.baseURL) : undefined;
  const configured = policy?.policy?.hasConfiguredApiKey ??
    (typeof configuredKey === 'string' && Boolean(configuredKey.trim()));
  const modelId = profile.nativeGeneration === 'v2' ? input.modelId
    : openCodeModelId(input.providerId, input.modelId);
  const configuration = profile.nativeGeneration === 'v2' && profile.embedded?.configurationSource
    ? captureOpenCodeV2Configuration(profile, { providerId: input.providerId, modelId }, ownerCurrent,
      'model', { source, config: raw }) : undefined;
  const needsKey = !configuration?.selectedFile && (profile.nativeGeneration === 'v2' || loopback(selectedUrl) && !configured);
  const fallbackKey = needsKey && !configuration?.key
    ? new OpenCodeV2CredentialScope(profile, input.providerId, source.isCurrent).capture() : undefined;
  const key = needsKey ? configuration?.key ?? fallbackKey : undefined;
  const v2Fallback = profile.nativeGeneration === 'v2' ? fallbackKey : undefined;
  let fileProof: AcceptedOpenCodeV2FileKey | undefined;
  const nativeCurrent = () => {
    try {
      // This locally captured fallback brackets every auth read with the exact
      // source's fresh config and owner checks, including absent source files.
      if (v2Fallback !== undefined)
        return v2Fallback.isCurrent() && (fileProof?.filesCurrent() ?? true);
      // The private V1 bracket enters the same full owner check in source.isCurrent().
      if (!bracket && !ownerCurrent()) return false;
      // A nominal configuration key carries configuration.isCurrent itself.
      // Only a separate fallback key needs another check after that same callback.
      return source.isCurrent() && (configuration?.isCurrent() ?? true) &&
        (key === configuration?.key || (key?.isCurrent() ?? true)) && (fileProof?.filesCurrent() ?? true);
    } catch { return false; }
  };
  const current = () => {
    try { return nativeCurrent() && (policy?.isCurrent() ?? true); } catch { return false; }
  };
  if (!bracket && !current()) held();
  if (configuration?.selectedFile) {
    // Initial scope commits the original source/selection but cannot invent its future native key.
    if (!original) return undefined;
    const assertOriginal = () => {
      if (!current() || original.phase !== 'completed' || !original.ok || original.resourceHeld ||
          !original.context || original.profileId !== profile.profileId || original.configRevision !== profile.configRevision ||
          original.providerId !== input.providerId ||
          (profile.nativeGeneration === 'v2' ? original.modelId !== input.modelId
            : original.modelId !== input.modelId && `${input.providerId}/${original.modelId}` !== input.modelId) ||
          (original.purpose === undefined ? original.readinessScope?.kind !== 'native' :
            original.purpose !== nativeLocalReadinessPurpose || !original.readiness || original.readiness.context !== original.context ||
            original.readiness.selectionDigest !== original.selectionDigest ||
            original.readiness.evidence.ordinary !== 'confirmed' || original.readiness.evidence.decision !== 'allow')) held();
    };
    assertOriginal();
    if (!original.nativeFileKeyWitness) held();
    if (prepareFile) { prepareFile(configuration.selectedFile, assertOriginal); return undefined; }
    if (!preparedFileKey || preparedFileKey.commandId !== original.commandId ||
        preparedFileKey.context !== original.context ||
        !AcceptedOpenCodeV2FileKey.matches(preparedFileKey.proof, configuration.selectedFile) ||
        preparedFileKey.proof.encoded !== original.nativeFileKeyWitness || !preparedFileKey.proof.filesCurrent()) held();
    fileProof = preparedFileKey.proof;
  } else if (preparedFileKey) held();
  if (original?.nativeFileKeyWitness !== undefined && !fileProof) held();
  const nativeCredentialScopeDigest = fileProof?.scopeDigest ?? (key?.present ? key.digest : undefined);
  const account = {
    digest: managementDigest({ binding: profile.accountBinding, key: fileProof?.scopeDigest ?? key?.digest ?? null,
      configuredKey: typeof configuredKey === 'string' ? configuredKey : null }),
    isCurrent: current,
    ...(profile.nativeGeneration === 'v2' && nativeCredentialScopeDigest !== undefined ? { nativeCredentialScopeDigest } : {}),
  };
  if (bracket) {
    // The pure configured-key read is inside source capture's closing freshness check.
    // No source effect/await intervenes; future account checks still use nativeCurrent.
    if (configuration || key || fileProof) held();
    const target = memberTarget!();
    return { account, origin: policy, memberReference: {
      target, originCurrent: policy!.isCurrent(), accountDigest: account.digest,
    } };
  }
  return { account, origin: policy };
}

/** One original released receipt; crypto never runs while holding an account authority token. */
export async function prepareOpenCodeProbeFileKey(options: {
  profile: OpenCodeManagementProfile;
  original: Readonly<StoredModelProbe>;
  readOriginal(): Readonly<StoredModelProbe>;
  isCurrent(): boolean;
  withAccountRead?: <T>(read: () => T) => T;
}): Promise<PreparedModelFileKey | undefined> {
  const original = structuredClone(options.original);
  if (original.nativeFileKeyWitness === undefined) return undefined;
  const captured: { value?: { source: DeferredOpenCodeV2FileKey; assertOriginal(): void } } = {};
  const capture = () => {
    captureOpenCodeProbeAccountInspection(options.profile, original, options.isCurrent, original,
      original.localModelReadinessOrigin, undefined, undefined,
      (source, assertOriginal) => { captured.value = { source, assertOriginal }; });
  };
  if (options.withAccountRead) options.withAccountRead(capture); else capture();
  const selected = captured.value;
  if (!selected || !original.context) held();
  const assertOriginal = () => {
    const check = () => {
      if (!options.isCurrent() || !managementValuesEqual(original, options.readOriginal())) held();
      selected.assertOriginal();
    };
    if (options.withAccountRead) options.withAccountRead(check); else check();
  };
  assertOriginal();
  const proof = await AcceptedOpenCodeV2FileKey.retained(selected.source, original.nativeFileKeyWitness, assertOriginal);
  assertOriginal();
  if (!AcceptedOpenCodeV2FileKey.matches(proof, selected.source) || !proof.filesCurrent()) held();
  return Object.freeze({ commandId: original.commandId, context: original.context, proof });
}
