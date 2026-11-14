import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse as parsePath, resolve, sep } from 'node:path';
import { actualCaptureReadinessCommandId, localModelReadinessCaptureViewSchema, parseLiveRosterResponse } from '@agent-teams/legacy-agent-host/team-host';

import {
  createOpenCodeGlobalConfigEnvironmentResolver,
  isPrivateNetworkRuntimeLocalProviderUrl,
  JsonLocalProviderPrivateNetworkApprovalStore,
  LocalProviderOperationError,
  normalizeRuntimeLocalProviderTarget,
  OPENCODE_GLOBAL_CONFIG_FILENAMES,
  OPENCODE_PROJECT_CONFIG_CANDIDATES,
  readOpenCodeConfigTarget,
  resolveConfiguredProviderPreset,
} from '@features/runtime-provider-management/main';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import { getNodeValue, parseTree } from 'jsonc-parser';

import { projectBackendResult } from '../adapters/output/projectBackendResult';
import { parseLaunchModelPreparation } from '../adapters/input/teamOperationValues';
import { assertBackendRequestGuard, BackendRoutingError } from '../application/backendBinding';
import { capturedTeamModelProbeRootId } from '../application/prepareCapturedTeamModels';

import type { BackendHandle } from '../../contracts';
import type { BackendLaunchConfigurationView, BackendLaunchModelSelection } from '../../contracts/launch';
import type { TeamModelProbeIntents } from '../application/TeamModelProbeIntents';
import type { CapturedRosterCommands } from './CapturedRosterCommands';
import type { CapturedTeamRegistry } from './CapturedTeamRegistry';
import type { BackendOwnerBinding, BackendOwnerRef, BackendScope } from '../application/backendBinding';
import type { BackendOwnerRouter, BoundBackendCommand } from '../application/BackendOwnerRouter';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import type { LocalModelReadinessCaptureView, LocalModelReadinessOrigin, LocalModelReadinessPreparation, ReadinessSourceReference } from '@agent-teams/legacy-agent-host/team-host';
import type { CreateTeamLaunchPreparationInput } from '@agent-teams/legacy-agent-host/team-registry/create-launch-contracts';
import type { TeamRegistryRecord } from '@agent-teams/legacy-agent-host/team-registry/contracts';
import type { Node as JsoncNode,ParseError } from 'jsonc-parser';

type Row = Record<string, unknown>;
type Scope = LocalModelReadinessOrigin['workspaces'][number]['project'];
type View = Pick<BackendLaunchConfigurationView, 'members'> & {
  launch: Pick<BackendLaunchConfigurationView['launch'], 'launchId' | 'rosterRevision'> &
    Partial<Pick<BackendLaunchConfigurationView['launch'], 'members' | 'admission'>>;
};
type Definition = { owner: BackendOwnerRef; contextId: string; scope: BackendScope };
export interface CapturedRuntimeReadinessTarget {
  launchId: string;
  memberId: string;
  expectedGeneration: string;
}
interface ReadinessRouting {
  requestTimeoutMs?: number;
  intents?: TeamModelProbeIntents;
  rosterCommands?: Pick<CapturedRosterCommands, 'readOriginalIntent'>;
}
/** Main-only invocation context. It is never parsed from a renderer request or persisted as a clock. */
export interface LocalModelReadinessContext {
  remainingMs(): number;
  view?: View;
}
const object = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const held = (): never => { throw new BackendRoutingError('hold'); };
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function readinessOriginDigest(value: unknown): string {
  const canonical = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(canonical)
    : object(entry) ? Object.fromEntries(Object.entries(entry).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)])) : entry;
  return sha(JSON.stringify(canonical(value)));
}
export function readinessRemaining(context: LocalModelReadinessContext, outcome: 'not-dispatched' | 'unknown' = 'not-dispatched'): number {
  const value = Math.floor(context.remainingMs());
  if (!Number.isSafeInteger(value) || value <= 0 || value > 100000) throw new BackendRoutingError('hold', outcome);
  return value;
}

/** Finite original-path read. The reference contains no configuration or credential bytes. */
export async function captureReadinessSource(
  filePath: string, root: string, maximum: number, current: () => void
): Promise<{ source: ReadinessSourceReference; raw: string | null }> {
  if (!isAbsolute(filePath) || resolve(filePath) !== filePath || !isAbsolute(root) ||
      resolve(root) !== root || filePath !== root && !filePath.startsWith(root.endsWith(sep) ? root : root + sep) ||
      /[\0\r\n]/u.test(filePath + root) || maximum < 1 || maximum > 1024 * 1024) return held();
  const wait = async <T>(work: () => Promise<T>): Promise<T> => {
    current();
    const value = await work();
    current();
    return value;
  };
  const locate = async () => {
    current();
    const directories: unknown[] = [];
    let directory = parsePath(filePath).root;
    for (const part of ['', ...dirname(filePath).slice(directory.length).split(sep).filter(Boolean)]) {
      if (part) directory = join(directory, part);
      let stat;
      try { stat = await wait(() => fs.lstat(directory)); }
      catch (error) {
        current();
        if (object(error) && error.code === 'ENOENT')
          return { identity: { directories, missing: directory }, file: undefined };
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) return held();
      directories.push([directory, stat.dev, stat.ino, stat.mode, stat.uid]);
    }
    let file;
    try { file = await wait(() => fs.lstat(filePath)); }
    catch (error) {
      current();
      if (object(error) && error.code === 'ENOENT')
        return { identity: { directories, missing: filePath }, file: undefined };
      throw error;
    }
    if (!file.isFile() || file.isSymbolicLink() || file.nlink < 1 || file.size > maximum) return held();
    return { identity: { directories, file: [
      file.dev, file.ino, file.mode, file.uid, file.size, file.mtimeMs, file.ctimeMs, file.nlink,
    ] }, file };
  };
  const before = await locate();
  let descriptor: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    if (!before.file) {
      if (readinessOriginDigest((await locate()).identity) !== readinessOriginDigest(before.identity)) return held();
      return { source: { root, path: filePath, present: false,
        digest: readinessOriginDigest({ path: filePath, root, ...before.identity }) }, raw: null };
    }
    descriptor = await wait(() => fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)));
    const originalDescriptor = descriptor;
    const first = await wait(() => originalDescriptor.stat());
    if (!first.isFile() || first.dev !== before.file.dev || first.ino !== before.file.ino ||
        first.size > maximum || first.nlink < 1) return held();
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await wait(() => originalDescriptor.read(bytes, length, bytes.length - length, length));
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maximum || length !== first.size) return held();
    const after = await wait(() => originalDescriptor.stat()), named = await locate();
    if (after.dev !== first.dev || after.ino !== first.ino || after.size !== first.size ||
        after.mtimeMs !== first.mtimeMs || after.ctimeMs !== first.ctimeMs || after.nlink !== first.nlink ||
        readinessOriginDigest(named.identity) !== readinessOriginDigest(before.identity)) return held();
    const body = bytes.subarray(0, length);
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(body);
    current();
    return { source: { root, path: filePath, present: true,
      digest: readinessOriginDigest({ path: filePath, root, ...before.identity, bytes: sha(body) }) }, raw };
  } finally {
    if (descriptor) { await descriptor.close(); current(); }
  }
}

function providers(raw: string | null): { invalid: boolean; providers: Scope['providers'] } {
  if (raw === null || !raw.trim()) return { invalid: false, providers: [] };
  const errors: ParseError[] = [];
  const tree = parseTree(raw, errors, { allowTrailingComma: true, disallowComments: false });
  const valid = (node: JsoncNode, depth: number): boolean => {
    if (depth > 64 || node.type === 'number' && !Number.isFinite(node.value)) return false;
    if (node.type === 'object') {
      const names = node.children?.map(row => row.children?.[0]?.value as unknown) ?? [];
      if (new Set(names).size !== names.length) return false;
    }
    return (node.children ?? []).every(child => valid(child, depth + 1));
  };
  if (!tree || tree.type !== 'object' || errors.length || !valid(tree, 0))
    return { invalid: true, providers: [] };
  const data: unknown = getNodeValue(tree);
  if (!object(data) || data.provider !== undefined && !object(data.provider))
    return { invalid: true, providers: [] };
  const rows: Scope['providers'] = [];
  for (const [id, value] of Object.entries(object(data.provider) ? data.provider : {})) {
    if (!object(value) || value.npm !== '@ai-sdk/openai-compatible' || !object(value.options) ||
        typeof value.options.baseURL !== 'string' || !value.options.baseURL) continue;
    try {
      const target = normalizeRuntimeLocalProviderTarget({
        presetId: 'custom', providerId: id, baseUrl: value.options.baseURL, allowPrivateNetwork: true,
      });
      const preset = resolveConfiguredProviderPreset(id, target.baseUrl);
      if (preset) rows.push({ providerId: target.providerId, baseUrl: target.baseUrl,
        preset: preset.id, hasConfiguredApiKey: typeof value.options.apiKey === 'string' && Boolean(value.options.apiKey) });
    } catch { /* The original connector excludes a declaration that it cannot normalize. */ }
  }
  if (rows.length > 256) return held();
  return { invalid: false, providers: rows };
}

export async function captureLocalModelReadinessOrigin(options: {
  kind: 'create' | 'team'; owner: BackendOwnerBinding; contextId: string; commandId: string;
  selection: unknown; workspaces: readonly string[]; current(): void; budget: LocalModelReadinessContext;
  targets: readonly { workspace: string; providerId: string | null }[];
  home?: string; environment?: NodeJS.ProcessEnv;
  readApprovals?: ReturnType<JsonLocalProviderPrivateNetworkApprovalStore['capture']>;
}): Promise<LocalModelReadinessOrigin> {
  const homeInput = resolve(options.home ?? homedir());
  const environment = { ...(options.environment ?? createOpenCodeGlobalConfigEnvironmentResolver(undefined)()) };
  const readApprovals = options.readApprovals ?? new JsonLocalProviderPrivateNetworkApprovalStore().capture();
  const identity = { schemaVersion: 1 as const, kind: options.kind,
    ownerDigest: readinessOriginDigest(options.owner), contextId: options.contextId,
    commandId: options.commandId, selectionDigest: readinessOriginDigest(options.selection) };
  const requested = [...new Set(options.workspaces)];
  const targets = options.targets.map(row => ({ ...row }));
  if (!requested.length || requested.length > 256 ||
      requested.some(path => !isAbsolute(path) || /[\0\r\n]/u.test(path)) ||
      !targets.length || targets.length > 256 || targets.some(row => !requested.includes(row.workspace)) ||
      requested.some(path => !targets.some(row => row.workspace === path))) return held();
  const targetsKnown = targets.every(row => row.providerId !== null &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(row.providerId));
  let invalidated = false;
  const current = () => {
    if (invalidated) return held();
    try { options.current(); readinessRemaining(options.budget); }
    catch (error) { invalidated = true; throw error; }
  };
  const read = (path: string, root: string, maximum = 1024 * 1024) =>
    captureReadinessSource(path, root, maximum, current);
  current();
  let globalHome: string | undefined;
  const scope = async (kind: 'global' | 'project', workspace: string): Promise<Scope> => {
    current();
    const root = kind === 'global' ? (globalHome ??= await fs.realpath(homeInput)) : workspace;
    current();
    const captured = new Map<string, Awaited<ReturnType<typeof read>>>();
    let selected: Awaited<ReturnType<typeof readOpenCodeConfigTarget>> | undefined;
    let selectorFailure: 'config-conflict' | 'config-invalid' | 'project-required' | undefined;
    try {
      selected = await readOpenCodeConfigTarget({
        scope: kind, projectPath: workspace, homePath: kind === 'global' ? root : homeInput,
        getEnvironment: () => environment,
        captureRead: { current, read: async path => {
          const value = await read(path, root);
          if (value.raw === null) return held();
          captured.set(path, value);
          return value.raw;
        } },
      });
    } catch (error) {
      current();
      if (!(error instanceof LocalProviderOperationError) ||
          !['config-conflict', 'config-invalid', 'project-required'].includes(error.code)) throw error;
      selectorFailure = error.code as typeof selectorFailure;
    }
    current();
    const paths = kind === 'global'
      ? OPENCODE_GLOBAL_CONFIG_FILENAMES.map(name => join(root, '.config', 'opencode', name))
      : OPENCODE_PROJECT_CONFIG_CANDIDATES.map(name => join(workspace, name));
    const sources: ReadinessSourceReference[] = [];
    for (const path of paths) {
      const next = await read(path, root);
      const original = captured.get(path);
      if (original && readinessOriginDigest(original.source) !== readinessOriginDigest(next.source)) return held();
      captured.set(path, next); sources.push(next.source);
    }
    if (selectorFailure)
      return { selectedPath: null, selectorFailure, invalid: true, providers: [], sources };
    if (!selected) return held();
    const existing = sources.filter(source => source.present);
    if (existing.length > 1 || (selected.raw === null ? existing.length !== 0
      : existing.length !== 1 || existing[0]?.path !== selected.configPath)) return held();
    const original = captured.get(selected.configPath);
    if (selected.raw !== null && (!original || original.raw !== selected.raw)) return held();
    return { selectedPath: selected.configPath, sources, ...providers(selected.raw) };
  };
  const workspaces: LocalModelReadinessOrigin['workspaces'] = [];
  let global: Scope | undefined;
  for (const original of requested) {
    current();
    const workspace = await fs.realpath(original); current();
    if (workspace !== original) return held();
    const project = await scope('project', workspace);
    let selectedGlobal: LocalModelReadinessOrigin['workspaces'][number]['global'];
    if (targetsKnown && !project.invalid && targets.filter(row => row.workspace === workspace)
      .every(target => project.providers.some(row => row.providerId === target.providerId))) {
      selectedGlobal = { notConsulted: 'project-precedence' };
    } else {
      global ??= await scope('global', workspace);
      selectedGlobal = global;
    }
    workspaces.push({ path: workspace, project, global: selectedGlobal });
  }
  if (workspaces.reduce((count, row) => count + row.project.providers.length +
    ('notConsulted' in row.global ? 0 : row.global.providers.length), 0) > 256)
    return held();
  const policies = targetsKnown ? targets.flatMap(target => {
    const workspace = workspaces.find(row => row.path === target.workspace)!;
    const project = workspace.project;
    const selected = !project.invalid && project.providers.some(row => row.providerId === target.providerId)
      ? project : 'notConsulted' in workspace.global ? undefined : workspace.global;
    const provider = selected?.providers.find(row => row.providerId === target.providerId);
    return selected?.selectedPath && provider ? [{ configPath: selected.selectedPath, provider }] : [];
  }) : workspaces.flatMap(row => [row.project, ...('notConsulted' in row.global ? [] : [row.global])].flatMap(selected => {
    const configPath = selected.selectedPath;
    return configPath === null ? [] : selected.providers.map(provider => ({ configPath, provider }));
  }));
  const tuples = policies.filter(row => isPrivateNetworkRuntimeLocalProviderUrl(row.provider.baseUrl))
    .map(({ configPath, provider }) => ({ configPath, providerId: provider.providerId, baseUrl: provider.baseUrl }));
  const approval: LocalModelReadinessOrigin['approval'] = targetsKnown && !tuples.length
    ? { notConsulted: 'no-private-target' }
    : await readApprovals(tuples, async (path, maximum) =>
      read(resolve(path), dirname(resolve(path)), maximum));
  current();
  const result: LocalModelReadinessOrigin = { ...identity, workspaces, approval };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) return held();
  const approvalSource = 'notConsulted' in approval ? undefined : approval.source;
  for (const source of [...new Map(workspaces.flatMap(row => [...row.project.sources,
    ...('notConsulted' in row.global ? [] : row.global.sources)])
    .map(source => [source.path, source])).values(), ...(approvalSource ? [approvalSource] : [])]) {
    const actual = await read(source.path, source.root, source.path === approvalSource?.path ? 131072 : 1024 * 1024);
    if (readinessOriginDigest(actual.source) !== readinessOriginDigest(source)) return held();
  }
  current();
  return result;
}

export interface CapturedReadinessOrigin {
  readonly origin: LocalModelReadinessOrigin;
  readonly budget: LocalModelReadinessContext;
}
export function createReadinessPreparation(
  origin: LocalModelReadinessOrigin, budget: LocalModelReadinessContext
): CapturedReadinessOrigin {
  return { origin: structuredClone(origin), budget };
}
export function readinessPreparationWire(value: CapturedReadinessOrigin): LocalModelReadinessPreparation {
  return { origin: value.origin, remainingMs: readinessRemaining(value.budget) };
}

function captureReadinessInputs() {
  return { home: homedir(), environment: { ...createOpenCodeGlobalConfigEnvironmentResolver(undefined)() },
    readApprovals: new JsonLocalProviderPrivateNetworkApprovalStore().capture() };
}

/** One original Create publisher. Its promise and source references survive same-intent polling. */
export function capturedCreateReadiness(router: BackendOwnerRouter, reference: BackendOwnerRef, guard: () => void) {
  const owner = router.ownerBinding(reference), fingerprint = readinessOriginDigest(owner);
  const inputs = captureReadinessInputs();
  const current = () => {
    guard();
    if (readinessOriginDigest(router.ownerBinding(reference)) !== fingerprint) return held();
  };
  let original: { digest: string; promise: Promise<LocalModelReadinessOrigin> } | undefined;
  return async (input: CreateTeamLaunchPreparationInput, budget: LocalModelReadinessContext) => {
    const selection = structuredClone(input), fingerprint = readinessOriginDigest(selection);
    current(); readinessRemaining(budget);
    if (original && original.digest !== fingerprint) return held();
    if (!original) {
      const settings = [selection.draft.savedSettings, ...selection.draft.members.map(row => ({
        ...selection.draft.savedSettings, ...row.memberSettings,
      }))].filter(row => row.providerId === 'opencode');
      original = { digest: fingerprint, promise: captureLocalModelReadinessOrigin({
        kind: 'create', owner, contextId: selection.draft.contextId, commandId: selection.preparationId,
        ...inputs, selection, workspaces: settings.map(row => row.cwd),
        targets: settings.map(row => ({ workspace: row.cwd,
          providerId: parseOpenCodeQualifiedModelRef(row.model)?.sourceId ?? null })), current, budget,
      }) };
    }
    const origin = await original.promise;
    current(); readinessRemaining(budget);
    return origin;
  };
}

/** Original selected client budget; reading another phase never restarts this clock. */
export function captureRequestReadinessBudget(requestTimeoutMs: number | undefined): LocalModelReadinessContext {
  if (!Number.isSafeInteger(requestTimeoutMs) || !requestTimeoutMs || requestTimeoutMs <= 0) return held();
  const admitted = performance.now(), duration = Math.min(100000, requestTimeoutMs);
  return { remainingMs: () => duration - (performance.now() - admitted) };
}

function currentReadiness(router: BackendOwnerRouter, definition: Definition,
  guard: BoundBackendCommand['guard'], budget: LocalModelReadinessContext) {
  const owner = router.ownerBinding(definition.owner), fingerprint = readinessOriginDigest(owner);
  const current = () => {
    assertBackendRequestGuard(guard);
    if (readinessOriginDigest(router.ownerBinding(definition.owner)) !== fingerprint) return held();
    readinessRemaining(budget);
  };
  current();
  return { owner, current };
}

/** The requested private attachment is stripped before the ordinary public projection. */
export async function readCapturedLaunchReadiness(options: {
  router: BackendOwnerRouter; handle: BackendHandle; definition: Definition;
  commandId: string; launchId: string; rosterRevision?: string;
  guard?: BoundBackendCommand['guard']; budget: LocalModelReadinessContext; capture?: true;
}) {
  const { router, handle, definition, budget } = options;
  const { current } = currentReadiness(router, definition, options.guard, budget);
  const request = { handle, commandId: `readiness-read-${readinessOriginDigest([options.commandId, options.launchId])}`,
    operation: 'team.launch.configuration.read' as const, payload: { launchId: options.launchId } };
  const raw = await router.request(handle, { commandId: request.commandId, method: request.operation,
    payload: request.payload, control: true, guard: options.guard, requestBudget: budget,
    ...(options.capture && options.rosterRevision ? { localModelReadinessCapture: {
      launchId: options.launchId, rosterRevision: options.rosterRevision,
    } } : {}) });
  current();
  if (!object(raw)) return held();
  const { localModelReadinessCapture, ...publicResult } = raw;
  if (!options.capture && localModelReadinessCapture !== undefined) return held();
  const result = projectBackendResult(request, publicResult as JsonValue);
  if (!result.ok || !result.value || !('launch' in result.value) || !('members' in result.value) ||
      result.value.launch.launchId !== options.launchId || options.rosterRevision !== undefined &&
      result.value.launch.rosterRevision !== options.rosterRevision) return held();
  const capture = localModelReadinessCapture === null || localModelReadinessCapture === undefined ? null
    : localModelReadinessCaptureViewSchema.parse(localModelReadinessCapture);
  if (capture && (capture.launchId !== options.launchId || capture.rosterRevision !== options.rosterRevision)) return held();
  return { view: result.value, capture };
}

/** Only a changed actual cwd starts its one already committed child; Host awaits that same probe. */
export async function prepareCapturedWorkspaces(options: {
  router: BackendOwnerRouter; handle: BackendHandle; definition: Definition;
  view: BackendLaunchConfigurationView; capture: LocalModelReadinessCaptureView;
  guard?: BoundBackendCommand['guard']; budget: LocalModelReadinessContext;
}): Promise<LocalModelReadinessContext> {
  const { router, handle, definition, view, capture, guard } = options;
  const received = performance.now(), remaining = capture.remainingMs;
  const budget = { remainingMs: () => Math.min(options.budget.remainingMs(), remaining - (performance.now() - received)) };
  const { owner, current } = currentReadiness(router, definition, guard, budget);
  if (capture.launchId !== view.launch.launchId || capture.rosterRevision !== view.launch.rosterRevision) return held();
  const selected = view.members.filter(row => {
    if (row.selected?.provider !== 'opencode') return false;
    const member = view.launch.members.find(member => member.memberId === row.memberId);
    if (!member) return held();
    return member.status !== 'skipped';
  });
  if (new Set(capture.targets.map(row => row.memberId)).size !== capture.targets.length ||
      capture.targets.some(target => !selected.some(row => row.memberId === target.memberId))) return held();
  let inputs: ReturnType<typeof captureReadinessInputs> | undefined;
  for (const target of capture.targets) {
    const row = selected.find(member => member.memberId === target.memberId)!.selected!;
    if (row.context !== undefined) return held();
    if (row.workspace === target.originalWorkspace) continue;
    inputs ??= captureReadinessInputs();
    const commandId = actualCaptureReadinessCommandId(capture.preparationId, capture.captureCommandId, target.memberId);
    const payload: BackendLaunchModelSelection = { launchId: capture.launchId, rosterRevision: capture.rosterRevision,
      memberId: target.memberId, model: row.model,
      ...(row.effort === undefined ? {} : { effort: row.effort }) };
    const origin = await captureLocalModelReadinessOrigin({ ...inputs, kind: 'team', owner,
      contextId: definition.contextId, commandId, selection: { handleId: handle.handleId, scope: definition.scope, payload },
      workspaces: [row.workspace], targets: [{ workspace: row.workspace,
        providerId: parseOpenCodeQualifiedModelRef(row.model)?.sourceId ?? null }], current, budget });
    current();
    const request = { handle, commandId, operation: 'team.launch.probe.start' as const, payload };
    const raw = await router.request(handle, { commandId, method: request.operation, payload: payload as unknown as JsonValue,
      guard, requestBudget: budget, localModelReadinessOrigin: createReadinessPreparation(origin, budget) });
    current();
    const result = projectBackendResult(request, raw);
    if (!result.ok || !result.value || !('phase' in result.value) || !('model' in result.value) ||
      result.value.phase !== 'running' && (result.value.phase !== 'completed' || !result.value.ok)) return held();
  }
  current();
  return budget;
}

/** Trusted Main phases retain their original owner, payload and remaining action time. */
export async function requestWithLocalModelReadiness(
  acquire: () => Promise<BackendOwnerRouter>, handle: BackendHandle, command: BoundBackendCommand,
  definition: Definition | undefined, routing: ReadinessRouting = {}
): Promise<JsonValue> {
  handle = { ...handle };
  command = { ...command, payload: structuredClone(command.payload),
    ...(command.localModelReadinessTarget ? { localModelReadinessTarget: structuredClone(command.localModelReadinessTarget) } : {}) };
  definition = definition ? structuredClone(definition) : undefined;
  const original = command.localModelReadinessContext;
  const preparation = original ? { remainingMs: original.remainingMs.bind(original),
    ...(original.view ? { view: structuredClone(original.view) } : {}) } : undefined;
  let payload = object(command.payload) ? command.payload : undefined;
  const locator = payload?.modelPreparation === undefined ? undefined : parseLaunchModelPreparation(payload.modelPreparation);
  if (locator) {
    if (!['team.launch.capture', 'team.launch.start'].includes(command.method)) return held();
    const { modelPreparation: _locator, ...wire } = payload!;
    command = { ...command, payload: wire as JsonValue }; payload = wire;
  }
  const savedCapture = command.method === 'team.launch.capture' && locator;
  const live = command.method === 'team.roster.replace' && routing.rosterCommands;
  const probe = command.method === 'team.launch.probe.start' && preparation;
  const aggregate = command.method === 'team.launch.start';
  const restart = command.method === 'team.member.action.execute' && payload?.action === 'restart';
  const open = command.method === 'runtime.open' && command.localModelReadinessTarget;
  if (!savedCapture && !live && !probe && !aggregate && !restart && !open) {
    const lookup = command.method === 'team.roster.lookup' && object(payload?.expected);
    const raw = await (await acquire()).request(handle, { ...command,
      ...(lookup ? { liveRoster: { phase: 'read' as const } } : {}) });
    if (object(raw) && ('liveRosterCapture' in raw || 'liveRosterPending' in raw))
      throw new BackendRoutingError('hold', 'unknown');
    return raw;
  }
  const draft = object(payload?.draft) ? payload.draft : undefined;
  const knownProvider = probe ? draft?.providerId ?? preparation.view?.members
    .find(row => row.memberId === payload?.memberId)?.selected?.provider : undefined;
  if (knownProvider === 'claude' || knownProvider === 'anthropic' || knownProvider === 'codex')
    return (await acquire()).request(handle, command);
  const budget = preparation ?? captureRequestReadinessBudget(routing.requestTimeoutMs);
  assertBackendRequestGuard(command.guard); readinessRemaining(budget);
  const router = await acquire();
  if (!definition || !payload) return held();
  const { owner, current } = currentReadiness(router, definition, command.guard, budget);
  if (savedCapture) {
    if (!routing.intents || !routing.rosterCommands || typeof payload.rosterCommandId !== 'string') return held();
    const originalRoster = await routing.rosterCommands.readOriginalIntent(handle.handleId, payload.rosterCommandId, command.guard);
    current();
    const probes = [];
    for (const selection of locator.selections) {
      const retained = await routing.intents.read(capturedTeamModelProbeRootId(handle, selection), locator.preparationId);
      current();
      if (!retained.retained) return held();
      probes.push({ commandId: retained.commandId, selection });
    }
    return router.request(handle, { ...command, requestBudget: budget, localModelReadinessTransfer: {
      preparationId: locator.preparationId, probes,
      roster: { commandId: originalRoster.commandId, expected: originalRoster.payload },
    } });
  }
  if (live) {
    const raw = await router.request(handle, { ...command, requestBudget: budget,
      liveRoster: { phase: 'capture', remainingMs: readinessRemaining(budget) } });
    current();
    if (!object(raw) || !('liveRosterCapture' in raw || 'liveRosterPending' in raw)) return raw;
    const response = parseLiveRosterResponse(raw);
    if (!response.ok || !('liveRosterCapture' in response)) throw new BackendRoutingError('hold', 'unknown');
    const capture = response.liveRosterCapture;
    if (capture.commandId !== command.commandId || capture.teamId !== definition.scope.teamId ||
      capture.requestDigest !== readinessOriginDigest({ commandId: command.commandId, payload }) ||
      capture.expectedRevision !== payload.expectedRevision) return held();
    let origin: CapturedReadinessOrigin | undefined;
    if (capture.target.provider === 'opencode') {
      const inputs = captureReadinessInputs();
      origin = createReadinessPreparation(await captureLocalModelReadinessOrigin({ ...inputs, kind: 'team', owner,
        contextId: definition.contextId, commandId: command.commandId,
        selection: { handleId: handle.handleId, scope: definition.scope, payload, liveRosterCapture: capture },
        workspaces: [capture.target.workspace], targets: [{ workspace: capture.target.workspace,
          providerId: capture.target.modelProviderId }], current, budget }), budget);
      current();
    }
    const result = await router.request(handle, { ...command, requestBudget: budget,
      liveRoster: { phase: 'continue', captureDigest: capture.captureDigest, remainingMs: readinessRemaining(budget) },
      ...(origin ? { localModelReadinessOrigin: origin } : {}) });
    current();
    if (object(result) && ('liveRosterCapture' in result || 'liveRosterPending' in result))
      throw new BackendRoutingError('hold', 'unknown');
    return result;
  }
  let view = preparation?.view;
  let capture: LocalModelReadinessCaptureView | null = null;
  const target = command.localModelReadinessTarget;
  const launchId = target?.launchId ?? payload.launchId;
  if (typeof launchId !== 'string') return held();
  if (!view) {
    const read = await readCapturedLaunchReadiness({ router, handle, definition, commandId: command.commandId,
      launchId, ...(typeof payload.rosterRevision === 'string' ? { rosterRevision: payload.rosterRevision } : {}),
      guard: command.guard, budget, ...(aggregate ? { capture: true } : {}) });
    view = read.view; capture = read.capture;
  }
  if (view.launch.launchId !== launchId || payload.rosterRevision !== undefined && view.launch.rosterRevision !== payload.rosterRevision)
    return held();
  if (aggregate && view.launch.admission?.commandId === command.commandId)
    return router.request(handle, command);
  if (target && (target.memberId !== payload.memberId || target.expectedGeneration !== payload.expectedGeneration ||
      view.launch.members?.find(row => row.memberId === target.memberId)?.generation !== target.expectedGeneration)) return held();
  const rows = aggregate ? view.members.filter(row =>
    !view!.launch.members?.some(member => member.memberId === row.memberId && member.status === 'skipped'))
    : view.members.filter(row => row.memberId === payload.memberId);
  const row = rows[0];
  if (!aggregate && !row && !draft) return held();
  const opencode = draft ? draft.providerId === 'opencode' : rows.some(row => row.selected?.provider === 'opencode');
  if (!opencode) {
    if (draft || rows.every(row => row.selected?.provider === 'claude' || row.selected?.provider === 'codex' ||
      view!.launch.members?.some(member => member.memberId === row.memberId && member.status === 'skipped')))
      return router.request(handle, command);
    return held();
  }
  current();
  if (aggregate) {
    if (!capture || locator && locator.preparationId !== capture.preparationId) return held();
    const remaining = await prepareCapturedWorkspaces({ router, handle, definition,
      view: view as BackendLaunchConfigurationView, capture, guard: command.guard, budget });
    return router.request(handle, { ...command, requestBudget: remaining });
  }
  const workspace = draft && typeof draft.workspace === 'string' ? draft.workspace : row?.selected?.workspace;
  if (!workspace) return held();
  const inputs = captureReadinessInputs();
  const model = typeof payload.model === 'string' ? payload.model : row?.selected?.model;
  const origin = await captureLocalModelReadinessOrigin({ ...inputs, kind: 'team', owner,
    contextId: definition.contextId, commandId: command.commandId,
    selection: { handleId: handle.handleId, scope: definition.scope, payload },
    workspaces: [workspace], targets: [{ workspace, providerId: parseOpenCodeQualifiedModelRef(model ?? null)?.sourceId ?? null }], current, budget });
  current();
  return router.request(handle, { ...command, requestBudget: budget,
    localModelReadinessOrigin: createReadinessPreparation(origin, budget) });
}

/** One captured Create conversation; recovered partial results never continue native work. */
export function captureCreatedTeamConversation(options: {
  client: CapturedTeamRegistry; router: BackendOwnerRouter; owner: BackendOwnerRef;
  contextId: string; guard: NonNullable<BoundBackendCommand['guard']>; requestTimeoutMs: number;
  refreshSources(cwd: string): Promise<void>;
  register(record: TeamRegistryRecord): Promise<void>;
}) {
  let preparedSources: Promise<void> | undefined;
  let captureOrigin: ReturnType<typeof capturedCreateReadiness> | undefined;
  const selected = (input: CreateTeamLaunchPreparationInput) => {
    if (input.draft.contextId !== options.contextId) throw new BackendRoutingError('forbidden');
    return structuredClone(input);
  };
  const hasOpenCode = (input: CreateTeamLaunchPreparationInput) =>
    input.draft.savedSettings.providerId === 'opencode' || input.draft.members.some(row => row.memberSettings.providerId === 'opencode');
  const retain = async <T extends { creation: { commandId: string; phase: string; record: TeamRegistryRecord } }>(commandId: string, result: T) => {
    if (result.creation.commandId !== commandId || result.creation.phase !== 'published')
      throw new BackendRoutingError('hold', 'unknown');
    await options.register(result.creation.record);
    return result;
  };
  return {
    prepare: async (action: 'prepare' | 'probe.read' | 'probe.cancel',
      input: CreateTeamLaunchPreparationInput, readiness?: LocalModelReadinessContext) => {
      const captured = selected(input);
      let origin: CapturedReadinessOrigin | undefined;
      if (action === 'prepare' && hasOpenCode(captured)) {
        if (!readiness) return held();
        const budget = { remainingMs: readiness.remainingMs.bind(readiness) };
        captureOrigin ??= capturedCreateReadiness(options.router, options.owner, () => assertBackendRequestGuard(options.guard));
        preparedSources ??= options.refreshSources(captured.draft.savedSettings.cwd);
        await preparedSources;
        origin = createReadinessPreparation(await captureOrigin(captured, budget), budget);
      }
      return options.client.prepareCreation(action, captured, action === 'probe.cancel' ? undefined : options.guard, origin);
    },
    submit: async (commandId: string, input: CreateTeamLaunchPreparationInput) => {
      const captured = selected(input);
      if (!hasOpenCode(captured))
        return retain(commandId, await options.client.submitCreation(commandId, captured, options.guard));
      const budget = captureRequestReadinessBudget(options.requestTimeoutMs);
      let result;
      try { result = await options.client.captureCreation(commandId, captured, options.guard, budget); }
      catch (error) {
        const retained = await options.client.lookupCreation(commandId, captured, options.guard);
        if (!retained) throw error;
        return retain(commandId, retained);
      }
      await retain(commandId, result);
      const handle = { handleId: result.creation.record.binding.handleId };
      const definition = { owner: options.owner, contextId: options.contextId, scope: result.creation.record.binding.scope };
      const read = await readCapturedLaunchReadiness({ router: options.router, handle, definition, commandId,
        launchId: result.launch.launchId, rosterRevision: result.launch.rosterRevision,
        guard: options.guard, budget, capture: true });
      if (!read.capture || read.capture.preparationId !== captured.preparationId) return held();
      const remaining = await prepareCapturedWorkspaces({ router: options.router, handle, definition,
        ...read, capture: read.capture, guard: options.guard, budget });
      return retain(commandId, await options.client.submitCreation(commandId, captured, options.guard,
        { launchId: result.launch.launchId, rosterRevision: result.launch.rosterRevision }, remaining));
    },
  };
}
