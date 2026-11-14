import { captureOpenCodeReadinessOrigin } from './OpenCodeReadinessOrigin.js';
import { captureOpenCodeConfigurationSource } from './OpenCodeConfigurationSource.js';
import { OpenCodeV2CredentialScope } from './OpenCodeV2CredentialScope.js';
import { closeCoordinationByDeadline } from './OpenCodeCoordinationEndpoint.js';
import { ManagementCommandError, nativeLocalReadinessEvidenceSchema } from '../../management/commandRecords.js';
import { managementDigest } from '../../management/identity.js';

import type { NativeCoordinationObservation } from './OpenCodeCoordinationProbe.js';
import type { ModelProbeInput, NativeModelProbe } from '../../management/ModelProbeOwner.js';
import type { LocalModelReadinessOrigin, NativeLocalReadinessEvidence } from '../../management/commandRecords.js';
import type { OpenCodeManagementProfile } from '../../management/profile.js';

type Row = Record<string, unknown>;
type Evidence = NativeLocalReadinessEvidence;
type Metadata = Evidence['metadata'];
type Reason = Evidence['reasons'][number];
export interface NativeReadinessCoordination extends NativeModelProbe {
  coordinationObservation(): NativeCoordinationObservation | undefined;
}
const held = (): never => { throw new ManagementCommandError('held'); };
const invalid = (): never => { throw new ManagementCommandError('invalid'); };
const object = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
const configuredIds = new Set(['ollama', 'lmstudio', 'atomic-chat', 'llama.cpp', 'local']);

/** Same hostname distinctions as the existing Main local-provider policy. No DNS expansion. */
function normalizedHost(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/(?:^\[|\]$)/g, '');
  if (!normalized.includes(':')) return normalized;
  const canonical = new URL('https://[' + normalized + ']').hostname;
  const mapped = /^\[::ffff:([a-f0-9]+):([a-f0-9]+)\]$/.exec(canonical);
  if (!mapped) return normalized;
  const high = Number.parseInt(mapped[1]!, 16), low = Number.parseInt(mapped[2]!, 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
}
function network(hostname: string) {
  const host = normalizedHost(hostname);
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  const octets = match?.slice(1).map(Number);
  const ipv4 = octets?.every(value => value <= 255) ? octets : undefined;
  const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '::1' || ipv4?.[0] === 127;
  const privateNetwork = !loopback && (host.endsWith('.local') ||
    host.includes(':') && /^f[cd]|^fe[89ab]/.test(host) ||
    ipv4 !== undefined && (ipv4[0] === 10 || ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31 ||
      ipv4[0] === 192 && ipv4[1] === 168 || ipv4[0] === 169 && ipv4[1] === 254));
  const unusable = host === '0.0.0.0' || host === '::' || host === '255.255.255.255' ||
    host.includes(':') && host.startsWith('ff') || ipv4 !== undefined && ipv4[0]! >= 224;
  return { loopback, privateNetwork, unusable };
}
function baseUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return undefined;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return undefined; }
  const host = network(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      host.unusable || !host.loopback && !host.privateNetwork && url.protocol !== 'https:') return undefined;
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path && path !== '/' ? path : '/v1';
  return url;
}
function nativeUrl(base: URL, path: string): URL {
  const url = new URL(base), root = url.pathname.replace(/\/+$/, '');
  url.pathname = (root.endsWith('/v1') ? root.slice(0, -3) : root) + path;
  url.search = ''; url.hash = '';
  return url;
}
const modelName = (value: string) => {
  const name = value.trim().toLowerCase();
  return name && !name.includes(':') ? name + ':latest' : name;
};

/**
 * Private adapter composition only. It has no journal, allocation grant, cache or retry.
 * The original ModelProbeOwner reserves and records the operation before run().
 */
export function createOpenCodeLocalModelReadiness(
  profile: OpenCodeManagementProfile,
  input: ModelProbeInput,
  ownerCurrent: () => boolean,
  adapters: {
    ordinary(observeProvider: (provider: unknown) => boolean, isCurrent: () => boolean): NativeModelProbe;
    coordination(provider: Row, key: string | undefined, isCurrent: () => boolean): NativeReadinessCoordination | undefined;
    fetchImpl?: typeof fetch;
  },
  origin?: LocalModelReadinessOrigin
): NativeModelProbe {
  const source = captureOpenCodeConfigurationSource(profile,
    profile.nativeGeneration === 'v2' ? profile.embedded?.configurationSource : undefined, ownerCurrent);
  const policyOrigin = origin ? captureOpenCodeReadinessOrigin(origin, profile, input.providerId, ownerCurrent) : undefined;
  const raw = source.read(), providers = object(raw.provider) ? raw.provider : {};
  const candidate = providers[input.providerId];
  const configured = object(candidate) ? candidate : undefined;
  const options = configured && object(configured.options) ? configured.options : {};
  const resolveString = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    if (value.includes('{file:')) invalid();
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu,
      (_match: string, braced: string | undefined, shell: string | undefined) => {
        const selected = profile.environment[braced ?? shell!];
        if (selected === undefined || selected.includes('\0')) return invalid();
        return selected;
      });
  };
  const compatible = configured?.npm === '@ai-sdk/openai-compatible';
  const selectedUrl = policyOrigin ? baseUrl(policyOrigin.policy?.baseUrl)
    : compatible ? baseUrl(resolveString(options.baseURL)) : undefined;
  const requirePrivateApproval = (value: unknown) => {
    if (!policyOrigin || typeof value !== 'string') return;
    let destination: URL;
    try { destination = new URL(value.trim()); } catch { return; }
    if (!network(destination.hostname).privateNetwork) return;
    const actual = baseUrl(value);
    if (!actual || !selectedUrl || !policyOrigin.policy || !policyOrigin.privateNetworkApproved ||
        actual.toString() !== selectedUrl.toString()) held();
  };
  // Original native configuration is already captured; a selector refusal is never private approval.
  requirePrivateApproval(resolveString(options.baseURL));
  // The original V1 native owner resolves a file token; this reader never opens the referenced secret.
  const configuredKey = policyOrigin && profile.nativeGeneration !== 'v2' &&
    typeof options.apiKey === 'string' && options.apiKey.includes('{file:')
    ? options.apiKey : resolveString(options.apiKey);
  const hasConfiguredKey = policyOrigin?.policy?.hasConfiguredApiKey ??
    (typeof configuredKey === 'string' && Boolean(configuredKey.trim()));
  const selectedModel = input.modelId.startsWith(input.providerId + '/')
    ? input.modelId.slice(input.providerId.length + 1) : input.modelId;
  if (!selectedModel || selectedModel.length > 256) invalid();
  const knownMissing = configuredIds.has(input.providerId) &&
    (policyOrigin ? !policyOrigin.policy : !compatible || !selectedUrl);
  if (policyOrigin?.invalid && (policyOrigin.policy || configuredIds.has(input.providerId))) held();
  if (selectedUrl && network(selectedUrl.hostname).privateNetwork && !policyOrigin?.privateNetworkApproved) held();
  const localCandidate = Boolean(selectedUrl && network(selectedUrl.hostname).loopback &&
    !hasConfiguredKey);
  const key = localCandidate
    ? new OpenCodeV2CredentialScope(profile, input.providerId, source.isCurrent).capture() : undefined;
  // V2 uses the captured credential; V1 observes the native SDK's resolved key below.
  let applicable = localCandidate && (profile.nativeGeneration !== 'v2' || key?.present !== true);
  const presetId = policyOrigin?.policy?.preset;
  let preset: Metadata['provider'] = !applicable ? 'custom'
    : (presetId ?? input.providerId) === 'ollama' ? 'ollama'
      : (presetId ?? input.providerId) === (presetId ? 'lm-studio' : 'lmstudio') ? 'lmstudio'
        : (presetId ?? input.providerId) === 'llama.cpp' ? 'llamacpp' : 'custom';
  const metadata: Metadata = { provider: preset, tools: null, modelListed: null,
    contextTokens: null, parameterCount: null, configuredContextTokens: null, trainedContextTokens: null,
    contextSource: 'unknown' };
  const reasons = new Set<Reason>();
  let effective: Row | undefined, effectiveDigest: string | undefined;
  let closed = false;
  const current = () => !closed && ownerCurrent() && source.isCurrent() &&
    (policyOrigin?.isCurrent() ?? true) && (key?.isCurrent() ?? true);
  const observeProvider = (value: unknown) => {
    if (!current()) held();
    if (!object(value) || Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) return held();
    const next = structuredClone(value), nextOptions = object(next.options) ? next.options : {};
    if (nextOptions.apiKey !== undefined && typeof nextOptions.apiKey !== 'string') held();
    requirePrivateApproval(nextOptions.baseURL);
    const actualUrl = baseUrl(nextOptions.baseURL);
    if (policyOrigin?.invalid && !policyOrigin.policy && !actualUrl) held();
    if (policyOrigin && actualUrl && network(actualUrl.hostname).privateNetwork &&
        (!policyOrigin.privateNetworkApproved || actualUrl.toString() !== selectedUrl?.toString())) held();
    if (compatible && !policyOrigin || policyOrigin?.policy) {
      if (next.npm !== '@ai-sdk/openai-compatible' || !actualUrl || !selectedUrl ||
          actualUrl.toString() !== selectedUrl.toString()) held();
    }
    if (policyOrigin?.policy?.hasConfiguredApiKey &&
        (typeof nextOptions.apiKey !== 'string' || !nextOptions.apiKey)) held();
    const digest = managementDigest(next);
    if (effectiveDigest !== undefined && digest !== effectiveDigest) held();
    if (typeof nextOptions.apiKey === 'string' && nextOptions.apiKey.length > 0) {
      applicable = false; preset = 'custom'; metadata.provider = preset;
    }
    effective = next; effectiveDigest = digest;
    return applicable;
  };
  const ordinary = adapters.ordinary(observeProvider, current); // Construction is effect-free.
  const timeoutMs = Math.min(profile.modelProbeTimeoutMs ?? 90000, ordinary.timeoutMs, 90000);
  const abort = new AbortController();
  let deadline = 0, running: Promise<boolean> | undefined, closing: Promise<boolean> | undefined;
  let ordinaryStarted = false, ordinaryClean = false;
  let coordination: NativeReadinessCoordination | undefined, coordinationClean = false;
  let evidence: Evidence | undefined;
  const check = (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (closed || !current() || !Number.isSafeInteger(deadline) || Date.now() >= deadline) held();
  };
  const read = async (url: URL, signal: AbortSignal, method: 'GET' | 'POST' = 'GET',
    body?: string, maximumMs = 3000): Promise<Row | null> => {
    check(signal);
    if (!selectedUrl || !applicable || url.origin !== selectedUrl.origin) return held();
    let response: Response | undefined, result: Row | null = null;
    const bounded = AbortSignal.any([signal, abort.signal,
      AbortSignal.timeout(Math.max(1, Math.min(maximumMs, deadline - Date.now())))]);
    try {
      response = await (adapters.fetchImpl ?? fetch)(url, { method, redirect: 'error', signal: bounded,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body } : {}) });
      check(signal);
      if (response.ok && response.body) {
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const row = await reader.read(); check(signal);
            if (row.done) break;
            bytes += row.value.byteLength;
            if (bytes > 1024 * 1024) break;
            chunks.push(row.value);
          }
          if (bytes <= 1024 * 1024) {
            const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            if (object(raw)) result = raw;
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
    } catch { /* Unavailable metadata is classified below, never a successful native check. */ }
    finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
    check(signal); // Authority/deadline errors cannot be swallowed into a warning.
    return result;
  };
  const inspectBefore = async (signal: AbortSignal) => {
    if (!applicable || !selectedUrl) return;
    const modelsUrl = new URL(selectedUrl.toString().replace(/\/+$/, '') + '/models');
    const inventory = await read(modelsUrl, signal, 'GET', undefined, 1200);
    if (!inventory || !Array.isArray(inventory.data)) { reasons.add('provider-unavailable'); return; }
    metadata.modelListed = inventory.data.some(value => object(value) && value.id === selectedModel);
    if (preset !== 'ollama' && !metadata.modelListed) { reasons.add('model-missing'); return; }
    // Ollama can load a configured model on demand; listing absence alone does not refuse it.
    if (preset === 'ollama') metadata.modelListed = null;
    if (preset === 'ollama') {
      const show = await read(nativeUrl(selectedUrl, '/api/show'), signal, 'POST', JSON.stringify({ model: selectedModel }));
      if (!show) { reasons.add('metadata-unavailable'); return; }
      if (Array.isArray(show.capabilities))
        metadata.tools = show.capabilities.filter(value => typeof value === 'string').includes('tools');
      const info = object(show.model_info) ? show.model_info : {};
      metadata.parameterCount = positive(Object.entries(info).find(([name, value]) =>
        name.endsWith('.parameter_count') && positive(value) !== null)?.[1]);
      metadata.trainedContextTokens = positive(Object.entries(info).find(([name, value]) =>
        name.endsWith('.context_length') && positive(value) !== null)?.[1]);
      const context = typeof show.parameters === 'string'
        ? /(?:^|\n)\s*num_ctx\s+(\d+)\s*(?:\n|$)/i.exec(show.parameters) : null;
      metadata.configuredContextTokens = context ? positive(Number.parseInt(context[1]!, 10)) : null;
    } else if (preset === 'llamacpp') {
      const url = nativeUrl(selectedUrl, '/props'); url.searchParams.set('model', selectedModel);
      const props = await read(url, signal);
      metadata.contextTokens = props && object(props.default_generation_settings)
        ? positive(props.default_generation_settings.n_ctx) : null;
      if (!props) reasons.add('metadata-unavailable');
    } else if (preset === 'lmstudio') {
      const data = await read(nativeUrl(selectedUrl, '/api/v1/models'), signal);
      if (!data) { reasons.add('metadata-unavailable'); return; }
      if (Array.isArray(data.models)) {
        for (const value of data.models) {
          if (!object(value)) continue;
          const instances = Array.isArray(value.loaded_instances) ? value.loaded_instances.filter(object) : [];
          const requested = instances.find(instance => instance.id === selectedModel);
          if (!requested && value.key !== selectedModel &&
              !(Array.isArray(value.variants) && value.variants.includes(selectedModel))) continue;
          const instance = requested ?? (instances.length === 1 ? instances[0] : undefined);
          const config = instance && object(instance.config) ? instance.config : {};
          metadata.contextTokens = positive(config.context_length);
          metadata.tools = object(value.capabilities) && typeof value.capabilities.trained_for_tool_use === 'boolean'
            ? value.capabilities.trained_for_tool_use : null;
          break;
        }
      } else if (Array.isArray(data.data)) {
        const model = data.data.find(value => object(value) && value.id === selectedModel);
        if (object(model)) {
          metadata.contextTokens = positive(model.loaded_context_length);
          metadata.tools = Array.isArray(model.capabilities)
            ? model.capabilities.filter(value => typeof value === 'string').includes('tool_use') : null;
        }
      }
    }
    if (metadata.contextTokens !== null) metadata.contextSource = 'local-metadata';
  };
  const inspectAfter = async (signal: AbortSignal) => {
    if (preset !== 'ollama' || !selectedUrl) return;
    const data = await read(nativeUrl(selectedUrl, '/api/ps'), signal);
    if (!data || !Array.isArray(data.models)) { reasons.add('metadata-unavailable'); return; }
    const selected = modelName(selectedModel);
    for (const value of data.models) {
      if (!object(value) || ![value.name, value.model].some(name =>
        typeof name === 'string' && modelName(name) === selected)) continue;
      metadata.contextTokens = positive(value.context_length);
      if (metadata.contextTokens !== null) metadata.contextSource = 'ollama-loaded';
      return;
    }
  };
  const finish = (ordinaryConfirmed: boolean, result: Evidence['coordination']): boolean => {
    if (policyOrigin && !current()) held();
    if (!ordinaryConfirmed) reasons.add('ordinary-unconfirmed');
    if (metadata.tools === false) reasons.add('tools-unsupported');
    if (metadata.contextTokens !== null && metadata.contextTokens < 16384) reasons.add('context-too-small');
    if (applicable) {
      if (metadata.tools === null) reasons.add('capabilities-unknown');
      if (metadata.contextTokens === null) reasons.add('context-unknown');
      if (metadata.parameterCount !== null && metadata.parameterCount < 3_000_000_000) reasons.add('small-model');
      if (metadata.contextTokens !== null && metadata.contextTokens < 65536) reasons.add('context-below-recommended');
    }
    const block = !ordinaryConfirmed || result === 'incompatible' || metadata.tools === false ||
      metadata.modelListed === false || metadata.contextTokens !== null && metadata.contextTokens < 16384 ||
      reasons.has('provider-unavailable') || reasons.has('model-missing');
    evidence = nativeLocalReadinessEvidenceSchema.parse({
      schemaVersion: 1, ordinary: ordinaryConfirmed ? 'confirmed' : 'unconfirmed', coordination: result,
      decision: block ? 'block' : 'allow', reasons: [...reasons],
      routeDigest: managementDigest({ providerId: input.providerId, modelId: selectedModel,
        baseUrl: selectedUrl?.toString() ?? null, effort: input.effort ?? null, limits: input.limits ?? null }),
      configurationDigest: managementDigest({ source: source.digest, effective: effectiveDigest ?? null,
        ...(policyOrigin ? { origin: policyOrigin.digest } : {}) }),
      accountDigest: managementDigest({ binding: profile.accountBinding, key: key?.digest ?? null,
        configuredKey: typeof configuredKey === 'string' ? configuredKey : null }), metadata,
    });
    return !block;
  };
  async function run(signal: AbortSignal, originalDeadline?: number): Promise<boolean> {
    if (originalDeadline === undefined || !Number.isSafeInteger(originalDeadline) ||
        originalDeadline <= Date.now() || originalDeadline - Date.now() > timeoutMs) return held();
    deadline = originalDeadline;
    const combined = AbortSignal.any([signal, abort.signal]); check(combined);
    if (knownMissing) { reasons.add('provider-unavailable'); return finish(false, 'unavailable'); }
    ordinaryStarted = true;
    const confirmed = await ordinary.run(combined, deadline); check(combined);
    ordinaryClean = await closeCoordinationByDeadline(ordinary.close(deadline), deadline); check(combined);
    if (!ordinaryClean) return held();
    if (!confirmed) return finish(false, 'unavailable');
    if (!effective) return held();
    if (!applicable) { reasons.add('not-applicable'); return finish(true, 'not-applicable'); }
    await inspectBefore(combined); check(combined);
    if (reasons.has('provider-unavailable') || reasons.has('model-missing') ||
        metadata.tools === false || metadata.contextTokens !== null && metadata.contextTokens < 16384)
      return finish(true, 'unavailable');
    coordination = adapters.coordination(effective, key?.readKey(), current); check(combined);
    let outcome: Evidence['coordination'];
    if (!coordination) {
      reasons.add('managed-configuration'); reasons.add('coordination-unavailable'); outcome = 'unavailable';
    } else {
      await coordination.run(combined, deadline); check(combined);
      const observation = coordination.coordinationObservation();
      coordinationClean = await closeCoordinationByDeadline(coordination.close(deadline), deadline); check(combined);
      if (!coordinationClean || !observation) return held();
      outcome = observation.status;
      if (observation.reason === 'request-rejected') reasons.add('request-rejected');
      else if (observation.status === 'incompatible') reasons.add('coordination-failed');
      else if (observation.status === 'unavailable') reasons.add('coordination-unavailable');
    }
    await inspectAfter(combined); check(combined);
    return finish(true, outcome);
  }
  return {
    timeoutMs,
    run: (signal, originalDeadline) => running ??= run(signal, originalDeadline),
    readiness: () => evidence === undefined ? undefined : structuredClone(evidence),
    close: originalDeadline => {
      closed = true; abort.abort();
      const work = async () => {
        await running?.catch(() => {});
        const clean = await Promise.all([
          ordinaryStarted ? ordinaryClean || ordinary.close(originalDeadline) : true,
          coordination ? coordinationClean || coordination.close(originalDeadline) : true,
        ]);
        return clean.every(Boolean);
      };
      return closing ??= closeCoordinationByDeadline(work(), originalDeadline ?? deadline);
    },
  };
}
