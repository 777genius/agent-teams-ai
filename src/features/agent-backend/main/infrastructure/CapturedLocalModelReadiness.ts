import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse as parsePath, resolve, sep } from 'node:path';

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
import { getNodeValue, parseTree } from 'jsonc-parser';

import { projectBackendResult } from '../adapters/output/projectBackendResult';
import { assertBackendRequestGuard, BackendRoutingError } from '../application/backendBinding';

import type { BackendHandle } from '../../contracts';
import type { BackendLaunchConfigurationView } from '../../contracts/launch';
import type { BackendOwnerBinding, BackendOwnerRef, BackendScope } from '../application/backendBinding';
import type { BackendOwnerRouter, BoundBackendCommand } from '../application/BackendOwnerRouter';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import type { LocalModelReadinessOrigin, LocalModelReadinessPreparation, ReadinessSourceReference } from '@agent-teams/legacy-agent-host/team-host';
import type { CreateTeamLaunchPreparationInput } from '@agent-teams/legacy-agent-host/team-registry/create-launch-contracts';
import type { Node as JsoncNode,ParseError } from 'jsonc-parser';

type Row = Record<string, unknown>;
type Scope = LocalModelReadinessOrigin['workspaces'][number]['project'];
type View = Pick<BackendLaunchConfigurationView, 'members'> & {
  launch: { launchId: string; rosterRevision: string };
};
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
  if (!requested.length || requested.length > 256 ||
      requested.some(path => !isAbsolute(path) || /[\0\r\n]/u.test(path))) return held();
  let invalidated = false;
  const current = () => {
    if (invalidated) return held();
    try { options.current(); readinessRemaining(options.budget); }
    catch (error) { invalidated = true; throw error; }
  };
  const read = (path: string, root: string, maximum = 1024 * 1024) =>
    captureReadinessSource(path, root, maximum, current);
  current();
  const home = await fs.realpath(homeInput); current();
  const scope = async (kind: 'global' | 'project', workspace: string): Promise<Scope> => {
    const root = kind === 'global' ? home : workspace;
    const captured = new Map<string, Awaited<ReturnType<typeof read>>>();
    current();
    let selected: Awaited<ReturnType<typeof readOpenCodeConfigTarget>> | undefined;
    let selectorFailure: 'config-conflict' | 'config-invalid' | 'project-required' | undefined;
    try {
      selected = await readOpenCodeConfigTarget({
        scope: kind, projectPath: workspace, homePath: home, getEnvironment: () => environment,
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
      ? OPENCODE_GLOBAL_CONFIG_FILENAMES.map(name => join(home, '.config', 'opencode', name))
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
    global ??= await scope('global', workspace);
    workspaces.push({ path: workspace, project, global });
  }
  if (workspaces.reduce((count, row) => count + row.project.providers.length + row.global.providers.length, 0) > 256)
    return held();
  const tuples = workspaces.flatMap(row => [row.project, row.global].flatMap(selected => {
    const configPath = selected.selectedPath;
    return configPath === null ? [] : selected.providers
      .filter(provider => isPrivateNetworkRuntimeLocalProviderUrl(provider.baseUrl))
      .map(provider => ({ configPath, providerId: provider.providerId, baseUrl: provider.baseUrl }));
  }));
  const approval = await readApprovals(tuples, async (path, maximum) =>
    read(resolve(path), dirname(resolve(path)), maximum));
  current();
  const result: LocalModelReadinessOrigin = { ...identity, workspaces, approval };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) return held();
  for (const source of [...new Map(workspaces.flatMap(row => [...row.project.sources, ...row.global.sources])
    .map(source => [source.path, source])).values(), approval.source]) {
    const actual = await read(source.path, source.root, source.path === approval.source.path ? 131072 : 1024 * 1024);
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
        ...inputs, selection, workspaces: settings.map(row => row.cwd), current, budget,
      }) };
    }
    const origin = await original.promise;
    current(); readinessRemaining(budget);
    return origin;
  };
}

/** Only trusted Main preparation supplies this context; ordinary router calls are unchanged. */
export async function requestWithLocalModelReadiness(
  acquire: () => Promise<BackendOwnerRouter>, handle: BackendHandle, command: BoundBackendCommand,
  definition: { owner: BackendOwnerRef; contextId: string; scope: BackendScope } | undefined
): Promise<JsonValue> {
  command = { ...command, payload: structuredClone(command.payload) };
  definition = definition ? structuredClone(definition) : undefined;
  const original = command.localModelReadinessContext;
  const preparation = original ? { remainingMs: original.remainingMs.bind(original),
    ...(original.view ? { view: structuredClone(original.view) } : {}) } : undefined;
  if (command.method !== 'team.launch.probe.start' || !preparation)
    return (await acquire()).request(handle, command);
  const originalPayload = object(command.payload) ? command.payload : undefined;
  const originalDraft = object(originalPayload?.draft) ? originalPayload.draft : undefined;
  const provider = originalDraft ? originalDraft.providerId : preparation.view?.members
    .find(row => row.memberId === originalPayload?.memberId)?.selected?.provider;
  if (provider === 'claude' || provider === 'anthropic' || provider === 'codex')
    return (await acquire()).request(handle, command);
  const inputs = captureReadinessInputs();
  assertBackendRequestGuard(command.guard); readinessRemaining(preparation);
  const router = await acquire();
  if (!definition || !object(command.payload) || typeof command.payload.launchId !== 'string' ||
      typeof command.payload.rosterRevision !== 'string') return held();
  const owner = router.ownerBinding(definition.owner);
  const payload = structuredClone(command.payload);
  const current = () => {
    assertBackendRequestGuard(command.guard);
    if (readinessOriginDigest(router.ownerBinding(definition.owner)) !== readinessOriginDigest(owner)) return held();
    readinessRemaining(preparation);
  };
  current();
  let view = preparation.view;
  if (!view) {
    const launchId = command.payload.launchId;
    const request = { handle, commandId: command.commandId + ':origin',
      operation: 'team.launch.configuration.read' as const, payload: { launchId } };
    const raw = await router.request(handle, {
      commandId: request.commandId, method: request.operation, payload: request.payload, control: true,
      ...(command.guard ? { guard: command.guard } : {}),
    });
    current();
    const result = projectBackendResult(request, raw);
    if (!result.ok || !result.value || !('launch' in result.value) || !('members' in result.value))
      return held();
    view = { launch: { launchId: result.value.launch.launchId,
      rosterRevision: result.value.launch.rosterRevision }, members: result.value.members };
  }
  if (view.launch.launchId !== payload.launchId || view.launch.rosterRevision !== payload.rosterRevision ||
      typeof payload.memberId !== 'string') return held();
  const row = view.members.find(row => row.memberId === payload.memberId);
  const draft = object(payload.draft) ? payload.draft : undefined;
  const opencode = draft ? draft.providerId === 'opencode' : row?.selected?.provider === 'opencode';
  if (!opencode) return router.request(handle, command);
  const workspace = draft && typeof draft.workspace === 'string' ? draft.workspace : row?.selected?.workspace;
  if (!workspace) return held();
  const origin = await captureLocalModelReadinessOrigin({
    ...inputs, kind: 'team', owner, contextId: definition.contextId, commandId: command.commandId,
    selection: { handleId: handle.handleId, scope: definition.scope, payload }, workspaces: [workspace], current, budget: preparation,
  });
  current();
  return router.request(handle, { ...command,
    localModelReadinessOrigin: createReadinessPreparation(origin, preparation) });
}
