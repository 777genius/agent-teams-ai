import { win32 } from 'node:path';

import {
  applyLaunchConfiguration,
  applyOpenCodeRuntimeSource,
  buildCodexMemberEnvironment,
  buildOpenCodeCoordinationConfig,
  buildOpenCodeCoordinationEnvironment,
  buildOpenCodeManagementEnvironment,
  buildOpenCodeMemberConfiguration,
  buildOpenCodeMemberEnvironment,
  capturedMcpServersSchema,
  codexTeamTokenEnvironment,
  modelProbeLimitsSchema,
  openCodeMcpServers,
  openCodeMemberPrompt,
  providerManagementProfileSchema,
  readOpenCodeLaunchConfig,
  runtimeMemberProfileSchema,
  selectOpenCodeCoordinationProvider,
  teamModelProbeProfile,
  verifyOpenCodeMcpPolicyPlugin,
  withOpenCodeModelLimits,
} from '@agent-teams/legacy-agent-host/owned-process';

import type {
  NativeProcessProfile,
  NativeTeamEndpoint,
  OpenCodeManagementProfile,
  OpenCodeMemberProfile,
  ProviderManagementProfile,
  ResolvedLaunchSpec,
  RuntimeMemberProfile,
} from '@agent-teams/legacy-agent-host/owned-process';
import type { RuntimeSourceCandidate } from '@agent-teams/legacy-agent-host/runtime-sources';

export type WindowsEnvironmentRecipe =
  | { kind: 'member' | 'template'; profile: RuntimeMemberProfile }
  | { kind: 'management'; profile: ProviderManagementProfile };
export type WindowsPolicyPlugin = Readonly<{ path: string; sha256: string }>;
type Environment = Record<string, string>;
type RecordValue = Record<string, unknown>;
type Selection = NativeProcessProfile & {
  provider: 'claude' | 'codex' | 'opencode';
  environmentRecipe?: WindowsEnvironmentRecipe;
};
type LimitChange = { providerId: string; modelId: string;
  limits: { contextTokens: number; outputTokens: number } };

const invalid: () => never = () => { throw new Error('Captured Windows environment mismatch'); };
const row = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : invalid();
const optionalRow = (value: unknown): RecordValue => value === undefined ? {} : row(value);
const token = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const id = (value: string) => value.length > 0 && value.length <= 256;
const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** The original private source remains the only base; requests supply no profile or hash grant. */
export function captureWindowsEnvironmentRecipe(kind: WindowsEnvironmentRecipe['kind'],
  raw: unknown): WindowsEnvironmentRecipe | undefined {
  if (kind === 'management') {
    const parsed = providerManagementProfileSchema.safeParse(raw);
    return parsed.success ? { kind, profile: parsed.data } : undefined;
  }
  const parsed = runtimeMemberProfileSchema.safeParse(raw);
  return parsed.success ? { kind, profile: parsed.data } : undefined;
}

/** Apply the retained publication through the same source/default transform used by Host. */
export function applyWindowsEnvironmentSource<T extends Selection>(original: T,
  candidate: RuntimeSourceCandidate): T {
  const selected = structuredClone(original);
  selected.executable = { ...candidate.executable };
  const recipe = selected.environmentRecipe;
  if (recipe) {
    recipe.profile.executable = { ...candidate.executable };
    if (recipe.profile.provider === 'opencode') {
      if (recipe.kind === 'management' && recipe.profile.provider === 'opencode')
        recipe.profile = applyOpenCodeRuntimeSource(recipe.profile, candidate);
      else if (recipe.kind !== 'management' && recipe.profile.provider === 'opencode')
        recipe.profile = applyOpenCodeRuntimeSource(recipe.profile, candidate);
    }
    selected.environment = { ...recipe.profile.environment };
  }
  return selected;
}

function decodeEnvironment(spec: ResolvedLaunchSpec): Environment {
  const entries: [string, string][] = [], names = new Set<string>();
  for (const entry of spec.environment) {
    const equals = entry.indexOf('='), name = entry.slice(0, equals);
    if (equals < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        names.has(name.toUpperCase()) || entry.includes('\0')) invalid();
    names.add(name.toUpperCase());
    entries.push([name, entry.slice(equals + 1)]);
  }
  return Object.fromEntries(entries);
}

function sameEnvironment(expected: Readonly<Environment>, actual: Environment): boolean {
  const keys = Object.keys(expected);
  return keys.length === Object.keys(actual).length &&
    keys.every(key => Object.hasOwn(actual, key) && actual[key] === expected[key]);
}

function endpoint(value: unknown, kind: 'team' | 'coordination'): NativeTeamEndpoint {
  const server = row(value), headers = row(server.headers);
  if (typeof server.url !== 'string' || typeof headers.Authorization !== 'string' ||
      !headers.Authorization.startsWith('Bearer ')) invalid();
  const bearerToken = headers.Authorization.slice(7);
  const address = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(\/.*)$/.exec(server.url);
  const path = kind === 'team' ? /^\/mcp\/[A-Za-z0-9_-]{32}$/ : /^\/coordination$/;
  if (!token(bearerToken) || !address || Number(address[1]) > 65535 || !path.test(address[2]!)) invalid();
  return { url: server.url, bearerToken };
}

/** Decode only limit leaves. Replaying the constructors below protects every other config field. */
function limitChanges(environment: Environment, actual: RecordValue, maximum: number): LimitChange[] {
  const original = readOpenCodeLaunchConfig(environment);
  if (!actual.provider || typeof actual.provider !== 'object' || Array.isArray(actual.provider)) {
    if (sameJson(actual.provider, original.provider)) return [];
    invalid();
  }
  const providers = optionalRow(actual.provider), before = optionalRow(original.provider);
  const changes: LimitChange[] = [];
  for (const [providerId, value] of Object.entries(providers)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const modelsValue = row(value).models;
    if (!modelsValue || typeof modelsValue !== 'object' || Array.isArray(modelsValue)) continue;
    const oldProvider = before[providerId];
    const oldModels = oldProvider && typeof oldProvider === 'object' && !Array.isArray(oldProvider)
      ? row(oldProvider).models : undefined;
    for (const [modelId, model] of Object.entries(row(modelsValue))) {
      if (!model || typeof model !== 'object' || Array.isArray(model)) continue;
      const oldModel = oldModels && typeof oldModels === 'object' && !Array.isArray(oldModels)
        ? row(oldModels)[modelId] : undefined;
      const oldLimit = oldModel && typeof oldModel === 'object' && !Array.isArray(oldModel)
        ? row(oldModel).limit : undefined;
      if (sameJson(row(model).limit, oldLimit)) continue;
      if (!id(providerId) || !id(modelId)) invalid();
      const limit = row(row(model).limit);
      const limits = modelProbeLimitsSchema.parse({ contextTokens: limit.context, outputTokens: limit.output });
      changes.push({ providerId, modelId, limits });
      if (changes.length > maximum) invalid();
    }
  }
  return changes;
}

function launch(profile: OpenCodeMemberProfile, model?: string,
  permissions?: 'manual' | 'bypass'): OpenCodeMemberProfile {
  const prefix = profile.nativeOptions.providerId + '/';
  const choices = [model === prefix + profile.model ? undefined : model];
  // A valid bare choice may acquire a longer qualified name only in the native config.
  if (model !== undefined && choices[0] !== undefined && model.startsWith(prefix))
    choices.push(model.slice(prefix.length));
  for (const choice of choices) {
    try {
      const selected = applyLaunchConfiguration(profile, {
        ...(choice === undefined ? {} : { model: choice }),
        ...(permissions === undefined ? {} : { permissions }),
      });
      if (selected.provider === 'opencode' && selected.nativeGeneration !== 'v2') return selected;
    } catch { /* Try only the same captured provider's other existing model representation. */ }
  }
  return invalid();
}

/** Raw capture plus at most two actual selections; no candidate config becomes a new base. */
function memberBases(profile: OpenCodeMemberProfile, actual: RecordValue,
  finalModel?: string): OpenCodeMemberProfile[] {
  const changes = limitChanges(profile.environment, actual, finalModel === undefined ? 3 : 2);
  const initial = [profile];
  try { initial.push(launch(profile)); }
  catch { /* A raw profile can still serve exact legacy construction without an app selection. */ }
  for (const change of changes) {
    try { initial.push(launch(profile, `${change.providerId}/${change.modelId}`)); }
    catch { /* A changed leaf is not necessarily a permitted managed preference. */ }
  }
  const result = [...initial];
  if (finalModel !== undefined) {
    for (const base of initial)
      for (const permissions of [undefined, 'manual', 'bypass'] as const) {
        try { result.push(launch(base, finalModel, permissions)); }
        catch { /* Preserve the original launch-option refusal. */ }
      }
  } else {
    for (const base of initial.slice(1))
      for (const change of changes) {
        try { result.push(launch(base, `${change.providerId}/${change.modelId}`)); }
        catch { /* Only the existing mapper can admit a second managed overlay. */ }
      }
  }
  return result;
}

function capturedMcp(profile: OpenCodeMemberProfile, native: RecordValue) {
  const selected: RecordValue = Object.create(null);
  for (const [name, value] of Object.entries(native)) {
    if (name === 'team') continue;
    const server = row(value);
    if (server.type === 'local') {
      if (!Array.isArray(server.command) || server.command.length < 1) invalid();
      selected[name] = { type: 'stdio', command: server.command[0], args: server.command.slice(1),
        ...(server.environment === undefined ? {} : { env: server.environment }) };
    } else {
      if (server.type !== 'remote') invalid();
      selected[name] = { type: 'http', url: server.url,
        ...(server.headers === undefined ? {} : { headers: server.headers }) };
    }
  }
  return openCodeMcpServers({ ...profile, capturedMcpServers: capturedMcpServersSchema.parse(selected) });
}

function requiredTools(permission: unknown, serverName: string): string[] {
  const entries = Object.entries(row(permission)), result: string[] = [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const [name, value] = entries[index]!;
    if (value !== 'allow' || !name.startsWith(serverName + '_')) break;
    const tool = name.slice(serverName.length + 1);
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(tool)) break;
    result.unshift(tool);
  }
  if (!result.length || result.length > 256) invalid();
  return result;
}

function memberEnvironment(base: OpenCodeMemberProfile, actual: Environment,
  config: RecordValue, password: string, pluginPin: WindowsPolicyPlugin | undefined,
  policy: boolean): boolean {
  const original = readOpenCodeLaunchConfig(base.environment);
  const nativeMcp = row(config.mcp), agents = row(config.agent);
  const agent = row(agents[base.nativeOptions.agent]);
  if (typeof agent.prompt !== 'string') return false;
  const suffix = openCodeMemberPrompt(base, original, '');
  const instructions = !suffix ? agent.prompt : agent.prompt === suffix ? '' :
    agent.prompt.endsWith('\n\n' + suffix) ? agent.prompt.slice(0, -suffix.length - 2) : invalid();
  const prompt = openCodeMemberPrompt(base, original, instructions);
  let mcp: RecordValue, plugin: string | undefined, nonce: string | undefined;
  let prefix = 'legacy_host_team_0000000000000000', serverName = 'team';
  if (policy) {
    const pin = base.mcpPolicyPlugin ?? pluginPin;
    nonce = actual.LEGACY_AGENT_HOST_MCP_POLICY_NONCE;
    if (!pin || base.protocolRevision !== '1.19.4' || !nonce || !/^[a-f0-9]{64}$/.test(nonce)) return false;
    plugin = verifyOpenCodeMcpPolicyPlugin({ ...base, mcpPolicyPlugin: pin });
    mcp = capturedMcp(base, nativeMcp);
  } else {
    if (base.capturedMcpServers !== undefined) return false;
    mcp = optionalRow(original.mcp);
    const added = Object.keys(nativeMcp).filter(name => !Object.hasOwn(mcp, name));
    if (added.length !== 1) return false;
    serverName = added[0]!;
    if (Object.hasOwn(mcp, 'team')) {
      const match = /^(legacy_host_team_[a-f0-9]{16})(?:_[1-9]\d*)?$/.exec(serverName);
      if (!match) return false;
      prefix = match[1]!;
    }
  }
  const built = buildOpenCodeMemberConfiguration(base, original, prompt, {
    mcp, prefix, endpoint: endpoint(nativeMcp[serverName], 'team'),
    requiredToolNames: requiredTools(agent.permission, serverName), ...(plugin ? { plugin } : {}),
  });
  if (built.serverName !== serverName) return false;
  return sameEnvironment(buildOpenCodeMemberEnvironment(base.environment, built.nativeConfig, password,
    nonce ? { nonce, serverName } : undefined), actual);
}

function witness(config: RecordValue, original: RecordValue) {
  const agents = row(config.agent), before = optionalRow(original.agent);
  const names = Object.keys(agents).filter(name => /^management_[a-f0-9]{24}$/.test(name));
  const changed = names.filter(name => !sameJson(agents[name], before[name]));
  if (changed.length > 1) invalid();
  const name = changed[0] ?? names.find(value => token(row(agents[value]).prompt));
  if (!name) invalid();
  const value = row(agents[name]);
  if (!token(value.prompt)) invalid();
  return { witnessAgent: name, witness: value.prompt };
}

function managementEnvironment(base: OpenCodeManagementProfile, actual: Environment,
  config: RecordValue, password: string): boolean {
  const profiles = [base];
  for (const change of limitChanges(base.environment, config, 1)) {
    // A native probe input has bounded IDs; qualify only where its existing helper strips the prefix.
    const modelId = change.modelId.startsWith(change.providerId + '/')
      ? `${change.providerId}/${change.modelId}` : change.modelId;
    if (!id(modelId)) continue;
    profiles.push(withOpenCodeModelLimits(base, { ...change, modelId }));
  }
  for (const profile of profiles) {
    const original = readOpenCodeLaunchConfig(profile.environment);
    const expected = buildOpenCodeManagementEnvironment(profile.environment, original,
      { password, ...witness(config, original), coordination: false });
    if (sameEnvironment(expected, actual)) return true;
  }
  return false;
}

function coordinationEnvironment(base: OpenCodeManagementProfile, actual: Environment,
  config: RecordValue, password: string): boolean {
  const home = actual.HOME;
  if (!home || !base.environment.XDG_DATA_HOME) return false;
  const root = win32.dirname(home);
  if (!win32.isAbsolute(root) || win32.normalize(root) !== root ||
      win32.dirname(root) !== base.environment.XDG_DATA_HOME ||
      !/^agent-teams-coordination-[A-Za-z0-9]{6}$/.test(win32.basename(root))) return false;
  const environment = buildOpenCodeCoordinationEnvironment(base.environment, {
    home: win32.join(root, 'home'), config: win32.join(root, 'config'), data: win32.join(root, 'data'),
    cache: win32.join(root, 'cache'), state: win32.join(root, 'state'),
  });
  const providers = row(config.provider), keys = Object.keys(providers);
  if (keys.length !== 1 || !id(keys[0]!) || typeof config.model !== 'string' ||
      !config.model.startsWith(keys[0]! + '/')) return false;
  const providerId = keys[0]!, modelId = config.model.slice(providerId.length + 1);
  if (!id(modelId)) return false;
  const provider = selectOpenCodeCoordinationProvider(row(providers[providerId]), { providerId, modelId });
  if (!provider) return false;
  const original = buildOpenCodeCoordinationConfig(base, { providerId, modelId }, provider,
    endpoint(row(config.mcp).coordination, 'coordination'));
  return sameEnvironment(buildOpenCodeManagementEnvironment(environment, original,
    { password, ...witness(config, original), coordination: true }), actual);
}

/** Full environment membership, not provenance of the Host's logical Team/model policy inputs. */
export function matchesWindowsLaunchEnvironment(selected: Selection, spec: ResolvedLaunchSpec,
  pluginPin?: WindowsPolicyPlugin): boolean {
  try {
    const actual = decodeEnvironment(spec);
    if (sameEnvironment(selected.environment, actual)) return true;
    const recipe = selected.environmentRecipe;
    if (!recipe || recipe.profile.provider !== selected.provider) return false;
    if (recipe.profile.provider === 'codex') {
      const value = actual[codexTeamTokenEnvironment];
      return recipe.kind !== 'management' && token(value) &&
        sameEnvironment(buildCodexMemberEnvironment(recipe.profile.environment, value), actual);
    }
    if (recipe.profile.provider !== 'opencode' || recipe.profile.nativeGeneration === 'v2') return false;
    const password = actual.OPENCODE_SERVER_PASSWORD;
    if (actual.OPENCODE_SERVER_USERNAME !== 'opencode' || !token(password)) return false;
    const config = readOpenCodeLaunchConfig(actual);
    if (recipe.kind !== 'management' && recipe.profile.provider === 'opencode') {
      const management = teamModelProbeProfile(recipe.profile);
      if (management.provider !== 'opencode') return false;
      try { if (coordinationEnvironment(management, actual, config, password)) return true; }
      catch { /* Ordinary member and model servers retain their original namespaces/config. */ }
      const agent = optionalRow(config.agent)[recipe.profile.nativeOptions.agent];
      if (agent && typeof agent === 'object' && !Array.isArray(agent) && typeof row(agent).model === 'string') {
        try {
          for (const base of memberBases(recipe.profile, config, row(agent).model as string))
            for (const policy of [false, true]) {
              try { if (memberEnvironment(base, actual, config, password, pluginPin, policy)) return true; }
              catch { /* Another enumerated constructor may still match this exact environment. */ }
            }
        } catch { /* A member-derived model probe has its separate final limit overlay below. */ }
      }
      for (const base of memberBases(recipe.profile, config)) {
        const profile = teamModelProbeProfile(base);
        if (profile.provider !== 'opencode') continue;
        try { if (managementEnvironment(profile, actual, config, password)) return true; }
        catch { /* Preserve the separate management and general-coordination families. */ }
      }
      return false;
    }
    if (recipe.kind === 'management' && recipe.profile.provider === 'opencode') {
      try { if (managementEnvironment(recipe.profile, actual, config, password)) return true; }
      catch { /* General coordination intentionally replaces inline config and relocates namespaces. */ }
      return coordinationEnvironment(recipe.profile, actual, config, password);
    }
    return false;
  } catch { return false; }
}
