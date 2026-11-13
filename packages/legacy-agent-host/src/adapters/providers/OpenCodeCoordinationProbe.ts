import { lstatSync, readdirSync, realpathSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import { createOpenCodeV1DriverFactory } from '@agent-teams/provider-implementations/opencode';

import { captureOpenCodeConfigurationSource } from './OpenCodeConfigurationSource.js';
import {
  coordinationNames, coordinationPrompt, coordinationServer, OpenCodeCoordinationEndpoint, closeCoordinationByDeadline,
} from './OpenCodeCoordinationEndpoint.js';
import { ManagementCommandError } from '../../management/commandRecords.js';
import { managementDigest } from '../../management/identity.js';

import type { Session } from '@agent-teams/provider-session-contracts';
import type { OpenCodeClient } from '@agent-teams/provider-implementations/opencode';
import type { ModelProbeInput } from '../../management/ModelProbeOwner.js';
import type { OpenCodeManagementHost } from './OpenCodeManagementHost.js';
import type { NativeReadinessCoordination } from './OpenCodeLocalModelReadiness.js';
import type { OpenCodeManagementProfile } from '../../management/profile.js';

export interface OpenCodeV1Coordination {
  readonly input: ModelProbeInput;
  readonly endpoint: OpenCodeCoordinationEndpoint;
  readonly deadline: number;
  readonly config: Record<string, unknown>;
  readonly readiness?: true;
  isCurrent(): boolean;
  beforeAllocation(): void;
}
export const coordinationAgent = 'agent-teams-local-coordination';
const unavailable = (): never => { throw new ManagementCommandError('held'); };
const invalid = (): never => { throw new ManagementCommandError('invalid'); };
const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
};
const absent = (path: string): void => {
  try { lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  invalid();
};

/**
 * Phase A accepts the original closed Linux fixture configuration only.
 * General local source reduction belongs to the separately connected policy.
 */
export function captureCoordinationConfiguration(profile: OpenCodeManagementProfile,
  input: ModelProbeInput, ownerCurrent: () => boolean) {
  if (process.platform !== 'linux') return invalid();
  const v2 = profile.nativeGeneration === 'v2';
  const source = captureOpenCodeConfigurationSource(profile,
    v2 ? profile.embedded?.configurationSource : undefined, ownerCurrent);
  const original = source.read();
  for (const key of ['mcp', 'plugin', 'plugins', 'command', 'commands', 'mode', 'instructions', 'tools'])
    if (Object.hasOwn(original, key)) invalid();
  if (v2 && (Object.hasOwn(original, 'agent') || Object.hasOwn(original, 'agents'))) invalid();
  if (!v2) {
    const allowed = new Set(['$schema', 'autoupdate', 'share', 'enabled_providers', 'model',
      'small_model', 'permission', 'compaction', 'agent', 'provider']);
    if (Object.keys(original).some(key => !allowed.has(key))) invalid();
    const agents = original.agent === undefined ? {} : row(original.agent);
    if (Object.keys(agents).length > 16) invalid();
    for (const [name, value] of Object.entries(agents)) {
      const agent = row(value);
      if (name === 'title' || name === 'summary') {
        if (Object.keys(agent).join(',') !== 'disable' || agent.disable !== true) invalid();
      } else if (Object.keys(agent).join(',') !== 'mode' || agent.mode !== 'primary') invalid();
    }
  }
  const forbidden: string[] = [];
  if (!v2) {
    const environment = profile.environment;
    const allowedFlags = new Set(['OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_MODELS_FETCH',
      'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_TELEMETRY', 'OPENCODE_DISABLE_SHARE']);
    if (Object.keys(environment).some(key => key.toUpperCase().startsWith('OPENCODE_') &&
        !allowedFlags.has(key))) invalid();
    for (const [key, value] of Object.entries(environment))
      if (key.startsWith('OPENCODE_DISABLE_') && value !== '1') invalid();
    const home = environment.HOME!, config = join(environment.XDG_CONFIG_HOME!, 'opencode');
    forbidden.push(...['config', 'config.json', 'opencode.json', 'opencode.jsonc',
      'agent', 'agents', 'command', 'commands', 'mode', 'modes', 'plugin', 'plugins']
      .map(name => join(config, name)), join(home, '.opencode'),
      join(environment.XDG_DATA_HOME!, 'opencode', 'auth.json'),
      '/etc/opencode/opencode.json', '/etc/opencode/opencode.jsonc');
    let directory = profile.cwd;
    for (let count = 0; ; count++) {
      if (count >= 64) invalid();
      forbidden.push(join(directory, '.opencode'), join(directory, 'opencode.json'),
        join(directory, 'opencode.jsonc'));
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const assertCurrent = () => {
    if (!ownerCurrent() || !source.isCurrent()) unavailable();
    for (const path of forbidden) absent(path);
  };
  const beforeAllocation = () => {
    assertCurrent();
    if (!v2) {
      // The official V1 account/org loader reads this database before inline config.
      // A pre-existing database cannot be qualified by a clean fixture's inline bytes.
      const directory = join(profile.environment.XDG_DATA_HOME!, 'opencode');
      let names: string[];
      try { names = readdirSync(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (names.length > 64 || names.some(name => /\.db(?:-|$)/.test(name))) invalid();
    }
  };
  beforeAllocation();
  const provider = !v2 ? row(row(original.provider)[input.providerId]) : undefined;
  if (provider && provider.npm !== '@ai-sdk/openai-compatible') invalid();
  return Object.freeze({
    isCurrent: () => { try { assertCurrent(); return true; } catch { return false; } },
    beforeAllocation,
    v1Config(endpoint: OpenCodeCoordinationEndpoint) {
      assertCurrent();
      if (v2 || !provider) return invalid();
      const modelId = input.modelId.startsWith(input.providerId + '/')
        ? input.modelId.slice(input.providerId.length + 1) : input.modelId;
      const model = input.providerId + '/' + modelId;
      if (!Object.hasOwn(row(provider.models), modelId)) return invalid();
      const permission = coordinationV1Permissions();
      return {
        autoupdate: false, share: 'disabled', enabled_providers: [input.providerId],
        model, small_model: model, default_agent: coordinationAgent, plugin: [],
        permission, compaction: { auto: false }, provider: { [input.providerId]: provider },
        agent: { title: { disable: true }, summary: { disable: true },
          [coordinationAgent]: { mode: 'primary', model, permission, steps: 3 } },
        mcp: { [coordinationServer]: { type: 'remote', url: endpoint.url,
          headers: { Authorization: 'Bearer ' + endpoint.bearerToken },
          oauth: false, enabled: true, timeout: Math.min(profile.modelProbeTimeoutMs ?? 90000, 90000) } },
      };
    },
  });
}

export function coordinationV1Permissions() {
  return { '*': 'deny', ...Object.fromEntries(coordinationNames
    .map(name => [coordinationServer + '_' + name, 'allow'])) };
}

export function assertCoordinationDeadline(deadline: number, signal: AbortSignal,
  isCurrent: () => boolean): void {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(deadline) || Date.now() >= deadline || !isCurrent()) unavailable();
}

export type NativeCoordinationObservation = Readonly<{
  status: 'compatible' | 'incompatible' | 'unavailable';
  reason: 'complete' | 'challenge-failed' | 'request-rejected' | 'native-rejected';
}>;
type CoordinationArguments = [
  driver: Session, nativeSessionId: string, endpoint: OpenCodeCoordinationEndpoint,
  identity: string, signal: AbortSignal, deadline: number, isCurrent: () => boolean,
];

/** Phase A retains its original boolean and early-refusal behavior. */
export async function runNativeCoordination(...args: CoordinationArguments): Promise<boolean> {
  return (await observeCoordination(args, false))?.status === 'compatible';
}

/** Private B1 decision: only a bound terminal cut may classify a model's failure. */
export function readNativeCoordination(...args: CoordinationArguments) {
  return observeCoordination(args, true);
}

/** Only actual native Session events and the independently served endpoint facts can pass. */
async function observeCoordination(
  [driver, nativeSessionId, endpoint, identity, signal, deadline, isCurrent]: CoordinationArguments,
  classifyTerminal: boolean
): Promise<NativeCoordinationObservation | undefined> {
  const check = () => assertCoordinationDeadline(deadline, signal, isCurrent);
  check();
  const inputId = 'coordination-' + identity.slice(0, 32);
  const operationRef = 'coordination-operation-' + identity.slice(0, 32);
  const handed = await driver.submit({ inputId, operationRef, content: coordinationPrompt });
  check();
  if (!handed.ok) return undefined;
  const tools: { ref: string; name: string; input: unknown; message: string; completed: boolean }[] = [];
  let hasText = false, challenge = true, events = 0, bytes = 0;
  for await (const event of driver.observe()) {
    check();
    bytes += Buffer.byteLength(JSON.stringify(event));
    if (++events > 128 || bytes > 32768 || event.sessionRef !== driver.sessionRef ||
        event.inputId !== inputId || event.operationRef !== operationRef) return undefined;
    if (event.kind === 'tool') {
      if (tools.length >= 2 || tools.some(tool => !tool.completed || tool.ref === event.toolRef ||
          tool.message === event.messageRef) ||
          typeof event.toolRef !== 'string' || !event.toolRef || event.toolRef.length > 4096 ||
          typeof event.messageRef !== 'string' || !event.messageRef || event.messageRef.length > 4096 ||
          !event.toolRef.startsWith(event.messageRef + ':') || event.toolRef.length <= event.messageRef.length + 1 ||
          event.name !== coordinationServer + '_' + coordinationNames[tools.length]) return undefined;
      tools.push({ ref: event.toolRef, name: event.name, input: event.input,
        message: event.messageRef, completed: false });
    } else if (event.kind === 'tool-result') {
      const index = tools.findIndex(tool => tool.ref === event.toolRef), tool = tools[index];
      if (!tool || tool.completed) return undefined;
      if (event.isError || !endpoint.matches(nativeSessionId, index, tool.name, tool.input, event.content)) {
        if (!classifyTerminal) return undefined;
        challenge = false;
      }
      tool.completed = true;
    } else if (event.kind === 'text') {
      hasText ||= event.text.trim().length > 0;
    } else if (event.kind === 'result') {
      const complete = event.outcome === 'succeeded' && event.code === undefined && hasText &&
        challenge && tools.length === 2 && tools.every(tool => tool.completed) && endpoint.completed(nativeSessionId);
      if (complete) return { status: 'compatible', reason: 'complete' };
      if (!classifyTerminal) return undefined;
      if (event.outcome === 'succeeded' && event.code === undefined)
        return { status: 'incompatible', reason: 'challenge-failed' };
      if (event.outcome === 'failed' && event.code === 'unsupported')
        return { status: 'incompatible', reason: 'request-rejected' };
      if (event.outcome === 'failed' && event.code === undefined)
        return challenge ? { status: 'unavailable', reason: 'native-rejected' }
          : { status: 'incompatible', reason: 'challenge-failed' };
      return undefined; // Unknown/cancelled/foreign/expired is not a warning.
    } else if (event.kind !== 'usage') return undefined;
  }
  return undefined;
}

/** Uses the same V1 public Session driver as members, with a private inert policy and original custody. */
export async function openV1CoordinationSession(options: {
  profile: OpenCodeManagementProfile; input: ModelProbeInput; endpoint: OpenCodeCoordinationEndpoint;
  client: OpenCodeClient; fetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  signal: AbortSignal; deadline: number; isCurrent(): boolean; confirmStopped(): Promise<boolean>;
  readiness?: true;
}) {
  const { profile, input, endpoint, client, signal, deadline, isCurrent } = options;
  const check = () => assertCoordinationDeadline(deadline, signal, isCurrent);
  const modelId = input.modelId.startsWith(input.providerId + '/')
    ? input.modelId.slice(input.providerId.length + 1) : input.modelId;
  const model = { providerID: input.providerId, modelID: modelId };
  const identity = managementDigest({ profile, input });
  const verify = async () => {
    check();
    const config = row(await client.getConfig()); check();
    const permission = coordinationV1Permissions();
    const agent = row(row(config.agent)[coordinationAgent]);
    const servers = row(config.mcp), selected = row(servers[coordinationServer]);
    if (managementDigest(config.permission) !== managementDigest(permission) ||
        managementDigest(agent.permission) !== managementDigest(permission) ||
        agent.model !== input.providerId + '/' + modelId || agent.mode !== 'primary' ||
        agent.steps !== 3 || agent.disable === true || config.default_agent !== coordinationAgent ||
        !Array.isArray(config.plugin) || config.plugin.length !== 0 ||
        Object.keys(servers).join(',') !== coordinationServer || selected.type !== 'remote' ||
        selected.url !== endpoint.url || selected.enabled !== true || selected.oauth !== false ||
        row(selected.headers).Authorization !== 'Bearer ' + endpoint.bearerToken) return false;
    const providers = await client.getProviders(); check();
    const original = providers.all?.find(value => value.id === input.providerId);
    if (!original?.models || !Object.hasOwn(original.models, modelId)) return false;
    const selectedModel = row(original.models[modelId]);
    if (profile.variant !== undefined && !Object.hasOwn(row(selectedModel.variants), profile.variant))
      return false;
    if (input.limits) {
      const limit = row(selectedModel.limit);
      if (limit.context !== input.limits.contextTokens || limit.output !== input.limits.outputTokens ||
          typeof limit.input === 'number' && limit.input > input.limits.contextTokens) return false;
    }
    const status = await client.getMcp(); check();
    return Object.keys(status).join(',') === coordinationServer &&
      status[coordinationServer]?.status === 'connected' && endpoint.catalogCurrent();
  };
  if (!await verify()) return unavailable();
  const native = await client.createSession({ title: 'Native local coordination check' }); check();
  if (!/^ses_[A-Za-z0-9]+$/.test(native.id) || native.directory !== profile.cwd) return unavailable();
  endpoint.bindSession(native.id);
  const binding = { tenantId: 'provider-management', projectId: profile.profileId,
    sessionId: input.commandId, generation: 1 };
  const factory = createOpenCodeV1DriverFactory({
    capabilities: ['text', 'tools'], readCheckpoint: async () => unavailable(),
    resolveConfiguration: async request => {
      check();
      if (request.checkpointRef !== undefined) return undefined;
      return {
        endpoint: profile.endpoint, version: options.readiness
          ? typeof native.version === 'string' ? native.version : unavailable() : '1.19.4', workspacePath: profile.cwd,
        nativeSessionId: native.id, trustedBinding: identity, accountBinding: profile.accountBinding,
        profileBinding: profile.profileId, runBinding: input.commandId, configRevision: profile.configRevision,
        binding, model, agent: coordinationAgent,
        ...(profile.variant === undefined ? {} : { variant: profile.variant }),
        limits: { queuedInputs: 1, inputBytes: 1024, outputBytes: 32768, outputEvents: 128,
          pendingInteractions: 1, timeoutMs: Math.max(1, deadline - Date.now()) },
        fetchImpl: options.fetchImpl,
        probe: async () => {
          if (!await verify()) return false;
          const selected = await client.getSession(native.id); check();
          return selected.id === native.id && selected.directory === profile.cwd;
        },
        confirmStopped: options.confirmStopped,
      };
    },
  });
  const opened = await factory.open({ ...binding, configRevision: profile.configRevision,
    requiredCapabilities: ['text', 'tools'] });
  return { driver: opened.driver, nativeSessionId: native.id, identity };
}

type GeneralProvider = { provider: Record<string, unknown>; key?: string };

/** Stock native flags and private namespaces isolate this inert child, not the business profile. */
function captureLocalCoordinationConfiguration(profile: OpenCodeManagementProfile,
  input: ModelProbeInput, ownerCurrent: () => boolean, selected: GeneralProvider) {
  const source = captureOpenCodeConfigurationSource(profile, undefined, ownerCurrent);
  const provider = structuredClone(selected.provider), options = row(provider.options ?? {});
  const modelId = input.modelId.startsWith(input.providerId + '/')
    ? input.modelId.slice(input.providerId.length + 1) : input.modelId;
  if (provider.npm !== '@ai-sdk/openai-compatible' || !provider.models ||
      !Object.hasOwn(row(provider.models), modelId)) return undefined;
  if (selected.key !== undefined && options.apiKey === undefined) options.apiKey = selected.key;
  provider.options = options;
  provider.models = { [modelId]: row(provider.models)[modelId] };
  const system = process.platform === 'win32' ? join(profile.environment.ProgramData || 'C:\\ProgramData', 'opencode')
    : process.platform === 'darwin' ? '/Library/Application Support/opencode' : '/etc/opencode';
  const managed = ['opencode.json', 'opencode.jsonc'].map(name => join(system, name));
  if (process.platform === 'darwin') {
    let username: string;
    try { username = userInfo().username || 'user'; } catch { username = 'user'; }
    managed.push(join('/Library/Managed Preferences', username, 'ai.opencode.managed.plist'),
      '/Library/Managed Preferences/ai.opencode.managed.plist');
  }
  // Managed configuration loads after inline data; its presence is a concrete inability to isolate.
  const missing = (path: string) => {
    try { lstatSync(path); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  };
  if (managed.some(path => !missing(path))) return undefined;
  let root: string | undefined, prepared: OpenCodeManagementProfile | undefined;
  const roots = new Map<string, { dev: bigint; ino: bigint }>();
  const check = () => {
    if (!ownerCurrent() || !source.isCurrent() || managed.some(path => !missing(path))) unavailable();
    for (const [path, identity] of roots) {
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path ||
          stat.dev !== identity.dev || stat.ino !== identity.ino) unavailable();
    }
  };
  const retain = (path: string) => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) unavailable();
    roots.set(path, { dev: stat.dev, ino: stat.ino });
    return path;
  };
  return {
    isCurrent: () => { try { check(); return true; } catch { return false; } },
    beforeAllocation: check,
    initialize(deadline: number, signal: AbortSignal) {
      assertCoordinationDeadline(deadline, signal, () => { check(); return true; });
      if (prepared) return prepared;
      root = retain(mkdtempSync(join(profile.environment.XDG_DATA_HOME!, 'agent-teams-coordination-')));
      const directory = (name: string) => {
        const path = join(root!, name); mkdirSync(path, { mode: 0o700 }); return retain(path);
      };
      const home = directory('home'), config = directory('config'), data = directory('data');
      const cache = directory('cache'), state = directory('state');
      const environment = Object.fromEntries(Object.entries(profile.environment)
        .filter(([key]) => !key.toUpperCase().startsWith('OPENCODE_')));
      prepared = { ...profile, environment: { ...environment, HOME: home, USERPROFILE: home,
        XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache, XDG_STATE_HOME: state,
        OPENCODE_PURE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' } };
      assertCoordinationDeadline(deadline, signal, () => { check(); return true; });
      return prepared;
    },
    v1Config(endpoint: OpenCodeCoordinationEndpoint) {
      check();
      const model = input.providerId + '/' + modelId, permission = coordinationV1Permissions();
      return { autoupdate: false, share: 'disabled', enabled_providers: [input.providerId],
        model, small_model: model, default_agent: coordinationAgent, plugin: [], instructions: [],
        permission, compaction: { auto: false }, provider: { [input.providerId]: provider },
        agent: { title: { disable: true }, summary: { disable: true },
          [coordinationAgent]: { mode: 'primary', model, permission, steps: 3 } },
        mcp: { [coordinationServer]: { type: 'remote', url: endpoint.url,
          headers: { Authorization: 'Bearer ' + endpoint.bearerToken }, oauth: false, enabled: true,
          timeout: Math.min(profile.modelProbeTimeoutMs ?? 90000, 90000) } } };
    },
    close(deadline: number) {
      if (!root) return true;
      if (Date.now() >= deadline) return false;
      try {
        // Cleanup uses the original private directory identities, not current product authority.
        for (const [path, identity] of roots) {
          const stat = lstatSync(path, { bigint: true });
          if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path ||
              stat.dev !== identity.dev || stat.ino !== identity.ino) return false;
        }
        rmSync(root, { recursive: true }); root = undefined;
        return Date.now() < deadline;
      } catch { return false; }
    },
  };
}

/** Concrete V1 lifetime under the Coordinator's existing endpoint queue and management fence. */
export function createV1CoordinationProbe(profile: OpenCodeManagementProfile, input: ModelProbeInput,
  current: () => boolean, owner: {
    withHost(operation: { deadline: number; signal: AbortSignal; commandId: string; isCurrent(): boolean },
      action: (host: OpenCodeManagementHost, options: { signal: AbortSignal; timeoutMs: number }) => Promise<boolean>): Promise<boolean>;
    create(profile: OpenCodeManagementProfile, coordination: OpenCodeV1Coordination): OpenCodeManagementHost;
    retire(host: OpenCodeManagementHost): Promise<boolean>;
    begin(): void; publish(host: OpenCodeManagementHost): void; release(): void;
  }, general?: GeneralProvider): NativeReadinessCoordination | undefined {
  const selected = profile;
  const localConfiguration = general
    ? captureLocalCoordinationConfiguration(selected, input, current, general) : undefined;
  const configuration = general ? localConfiguration : captureCoordinationConfiguration(selected, input, current);
  if (!configuration) return undefined;
  const endpoint = new OpenCodeCoordinationEndpoint();
  let original: OpenCodeManagementHost | undefined, dedicated: OpenCodeManagementHost | undefined;
  let deadline = 0, running: Promise<boolean> | undefined, closing: Promise<boolean> | undefined;
  return {
    timeoutMs: Math.min(profile.modelProbeTimeoutMs ?? 90000, 90000),
    coordinationObservation: () => dedicated?.coordinationObservation(),
    run: (signal, originalDeadline) => {
      if (running) return running;
      if (originalDeadline === undefined || deadline) throw new ManagementCommandError('invalid');
      deadline = originalDeadline;
      return running = owner.withHost({ deadline, signal, commandId: input.commandId,
        isCurrent: configuration.isCurrent }, async (host, options) => {
        original = host; owner.begin();
        if (!await closeCoordinationByDeadline(owner.retire(host), deadline)) unavailable();
        options.signal.throwIfAborted();
        configuration.beforeAllocation();
        const childProfile = localConfiguration
          ? localConfiguration.initialize(deadline, options.signal) : selected;
        await endpoint.start(deadline, options.signal, configuration.isCurrent);
        options.signal.throwIfAborted();
        configuration.beforeAllocation();
        dedicated = owner.create(childProfile, { input, endpoint, deadline,
          config: configuration.v1Config(endpoint), isCurrent: configuration.isCurrent,
          beforeAllocation: configuration.beforeAllocation, ...(general ? { readiness: true } : {}) });
        owner.publish(dedicated);
        return dedicated.probeCoordination(options.signal);
      });
    },
    close: originalDeadline => {
      if (closing) return closing;
      endpoint.seal();
      const work = Promise.all([
        original ? owner.retire(original) : true,
        dedicated ? owner.retire(dedicated) : true,
        endpoint.close(),
      ]).then(results => {
        const clean = results.every(Boolean) && (!localConfiguration || localConfiguration.close(originalDeadline ?? deadline));
        if (clean) owner.release();
        return clean;
      });
      return closing ??= closeCoordinationByDeadline(work, originalDeadline ?? deadline);
    },
  };
}
