import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join, parse as parsePath, resolve, sep } from 'node:path';

import { getNodeValue, parseTree } from 'jsonc-parser';

import { localModelReadinessOriginSchema, localModelReadinessPreparationSchema, ManagementCommandError } from '../../management/commandRecords.js';
import { managementDigest } from '../../management/identity.js';
import type { LocalModelReadinessOrigin, LocalModelReadinessPreparation, ReadinessPreparationAnchor, ReadinessSourceReference } from '../../management/commandRecords.js';
import type { OpenCodeManagementProfile } from '../../management/profile.js';
import type { Node as JsoncNode, ParseError } from 'jsonc-parser';

type Row = Record<string, unknown>;
type Scope = LocalModelReadinessOrigin['workspaces'][number]['project'];
const object = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const held = (): never => { throw new ManagementCommandError('held'); };
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Reopens the named original source only. It never resolves an API-key file token. */
export function readOpenCodeReadinessSource(
  source: ReadinessSourceReference, maximum: number, current: () => void
): string | null {
  const { path, root } = source;
  if (!isAbsolute(path) || resolve(path) !== path || !isAbsolute(root) || resolve(root) !== root ||
      path !== root && !path.startsWith(root.endsWith(sep) ? root : root + sep) || /[\0\r\n]/u.test(path + root) ||
      maximum < 1 || maximum > 1024 * 1024) return held();
  const locate = () => {
    current();
    const directories: unknown[] = [];
    let directory = parsePath(path).root;
    for (const part of ['', ...dirname(path).slice(directory.length).split(sep).filter(Boolean)]) {
      if (part) directory = join(directory, part);
      current();
      let stat;
      try { stat = lstatSync(directory); }
      catch (error) {
        current();
        if (object(error) && error.code === 'ENOENT')
          return { identity: { directories, missing: directory }, file: undefined };
        throw error;
      }
      current();
      if (stat.isSymbolicLink() || !stat.isDirectory()) return held();
      directories.push([directory, stat.dev, stat.ino, stat.mode, stat.uid]);
    }
    current();
    let file;
    try { file = lstatSync(path); }
    catch (error) {
      current();
      if (object(error) && error.code === 'ENOENT')
        return { identity: { directories, missing: path }, file: undefined };
      throw error;
    }
    current();
    if (!file.isFile() || file.isSymbolicLink() || file.nlink < 1 || file.size > maximum) return held();
    return { identity: { directories, file: [
      file.dev, file.ino, file.mode, file.uid, file.size, file.mtimeMs, file.ctimeMs, file.nlink,
    ] }, file };
  };
  let fd: number | undefined;
  try {
    const before = locate();
    if (!before.file) {
      if (source.present || managementDigest(locate().identity) !== managementDigest(before.identity) ||
          source.digest !== managementDigest({ path, root, ...before.identity })) return held();
      return null;
    }
    if (!source.present) return held();
    current();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    current();
    const first = fstatSync(fd); current();
    if (!first.isFile() || first.dev !== before.file.dev || first.ino !== before.file.ino ||
        first.size > maximum || first.nlink < 1) return held();
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      current();
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      current();
      if (!count) break;
      length += count;
    }
    if (length > maximum || length !== first.size) return held();
    const after = fstatSync(fd); current();
    const named = locate();
    if (after.dev !== first.dev || after.ino !== first.ino || after.size !== first.size ||
        after.mtimeMs !== first.mtimeMs || after.ctimeMs !== first.ctimeMs || after.nlink !== first.nlink ||
        managementDigest(named.identity) !== managementDigest(before.identity)) return held();
    const body = bytes.subarray(0, length);
    if (source.digest !== managementDigest({ path, root, ...before.identity, bytes: hash(body) })) return held();
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(body); current();
    return raw;
  } catch { return held(); }
  finally { if (fd !== undefined) { closeSync(fd); current(); } }
}

function parsedConfiguration(raw: string | null): { invalid: boolean; value: Row } {
  if (raw === null || !raw.trim()) return { invalid: false, value: {} };
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
    return { invalid: true, value: {} };
  const value: unknown = getNodeValue(tree);
  return !object(value) || value.provider !== undefined && !object(value.provider)
    ? { invalid: true, value: {} } : { invalid: false, value };
}

function normalizedUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || value.trim().length > 2048) return undefined;
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = path && path !== '/' ? path : '/v1';
    return url.toString().replace(/\/$/, '');
  } catch { return undefined; }
}

function readScope(scope: Scope, workspace: string, kind: 'project' | 'global',
  providerId: string, read: (source: ReadinessSourceReference) => string | null) {
  const root = kind === 'project' ? workspace : scope.sources[0]?.root;
  if (!root) return held();
  const paths = kind === 'project'
    ? ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc']
      .map(name => join(root, name))
    : ['opencode.json', 'opencode.jsonc'].map(name => join(root, '.config', 'opencode', name));
  if (scope.sources.some((source, index) => source.root !== root || source.path !== paths[index])) return held();
  const existing = scope.sources.filter(source => source.present);
  if (scope.selectedPath !== null &&
      (existing.length > 1 || scope.selectedPath !== (existing[0]?.path ?? paths[0]))) return held();
  let raw: string | null = null;
  for (const source of scope.sources) {
    const value = read(source);
    if (source.path === scope.selectedPath) raw = value;
  }
  if (scope.selectedPath === null) return { policy: undefined, invalid: true, source: null };
  const parsed = parsedConfiguration(raw);
  if (scope.invalid !== parsed.invalid) return held();
  const policies = scope.providers.filter(row => row.providerId === providerId);
  if (policies.length > 1) return held();
  const policy = policies[0];
  if (policy) {
    const providers = object(parsed.value.provider) ? parsed.value.provider : {};
    const matches = Object.entries(providers).filter(([id]) => id.trim() === providerId);
    const selected = matches.length === 1 ? matches[0]?.[1] : undefined;
    const options = object(selected) && object(selected.options) ? selected.options : {};
    if (!object(selected) || selected.npm !== '@ai-sdk/openai-compatible' ||
        typeof options.baseURL !== 'string' || normalizedUrl(options.baseURL) !== policy.baseUrl ||
        policy.hasConfiguredApiKey !== (typeof options.apiKey === 'string' && Boolean(options.apiKey))) return held();
  }
  return { policy, invalid: parsed.invalid, source: scope.selectedPath };
}

/** Original Main policy and native route remain independent facts joined by the adapter. */
export function captureOpenCodeReadinessOrigin(
  raw: LocalModelReadinessOrigin,
  profile: Pick<OpenCodeManagementProfile, 'cwd'>,
  providerId: string,
  ownerCurrent: () => boolean
) {
  const origin = localModelReadinessOriginSchema.parse(raw);
  const workspace = origin.workspaces.find(row => row.path === profile.cwd);
  if (!workspace || origin.workspaces.length !== 1) return held();
  const current = () => { if (!ownerCurrent()) held(); };
  const inspect = () => {
    current();
    const sources = new Map<string, { digest: string; raw: string | null }>();
    const read = (source: ReadinessSourceReference, maximum = 1024 * 1024) => {
      const digest = managementDigest(source), previous = sources.get(source.path);
      if (previous) {
        if (previous.digest !== digest) return held();
        return previous.raw;
      }
      const raw = readOpenCodeReadinessSource(source, maximum, current);
      sources.set(source.path, { digest, raw });
      return raw;
    };
    const project = readScope(workspace.project, workspace.path, 'project', providerId, read);
    let selected = project, invalid = project.invalid;
    if ('notConsulted' in workspace.global) {
      if (!project.policy || project.invalid) return held();
      invalid = false;
    } else {
      const global = readScope(workspace.global, workspace.path, 'global', providerId, read);
      selected = project.policy && !project.invalid ? project : global;
      invalid = selected === project ? false : project.invalid || global.invalid;
    }
    let privateNetworkApproved = false;
    if (!('notConsulted' in origin.approval)) {
      const source = origin.approval.source;
      if (source.root !== dirname(source.path)) return held();
      const approvalRaw = read(source, 131072);
      let value: unknown;
      try { value = approvalRaw === null ? null : JSON.parse(approvalRaw); } catch { value = null; }
      const approved = object(value) && value.schemaVersion === 1 && Array.isArray(value.approvals)
        ? value.approvals.filter(object).flatMap(row =>
          typeof row.configPath === 'string' && typeof row.providerId === 'string' && typeof row.baseUrl === 'string'
            ? [{ configPath: resolve(row.configPath), providerId: row.providerId.trim(), baseUrl: row.baseUrl.trim() }] : [])
        : [];
      for (const tuple of origin.approval.approved) {
        if (!approved.some(row => managementDigest(row) === managementDigest(tuple))) return held();
      }
      const tuple = selected.policy && selected.source ? {
        configPath: selected.source, providerId, baseUrl: selected.policy.baseUrl,
      } : undefined;
      privateNetworkApproved = tuple !== undefined && origin.approval.approved.some(row =>
        managementDigest(row) === managementDigest(tuple));
    }
    current();
    return { policy: selected.policy, invalid, privateNetworkApproved };
  };
  const original = inspect(), digest = managementDigest(origin);
  return Object.freeze({
    ...original, digest,
    isCurrent: () => {
      try { return managementDigest(inspect()) === managementDigest(original); }
      catch { return false; }
    },
  });
}

export function originalReadinessSubset(origin: LocalModelReadinessOrigin, cwd: string, providerId: string) {
  const workspace = origin.workspaces.find(row => row.path === cwd);
  if (!workspace) return held();
  const scope = (value: Scope): Scope => ({ ...value,
    providers: value.providers.filter(row => row.providerId === providerId),
  });
  const selected = { ...workspace, project: scope(workspace.project),
    global: 'notConsulted' in workspace.global ? workspace.global : scope(workspace.global) };
  const paths = new Set([selected.project.selectedPath,
    ...('notConsulted' in selected.global ? [] : [selected.global.selectedPath])]);
  return localModelReadinessOriginSchema.parse({ ...origin, workspaces: [selected],
    approval: 'notConsulted' in origin.approval ? origin.approval
      : { ...origin.approval, approved: origin.approval.approved.filter(row =>
        row.providerId === providerId && paths.has(row.configPath)) },
  });
}

/** Computes the commitment from the complete original command, before the first native effect. */
export function captureReadinessPreparation(raw: LocalModelReadinessPreparation, expected: {
  kind: 'create' | 'team'; owner: unknown; contextId: string; commandId: string;
  selection: unknown; workspaces: readonly string[]; anchorCommandId: string;
  targets?: readonly { workspace: string; providerId: string }[];
  original: { present: boolean; anchor?: ReadinessPreparationAnchor };
  admittedAt: number;
}) {
  const input = localModelReadinessPreparationSchema.parse(raw), origin = input.origin;
  const identity = {
    originDigest: managementDigest(origin), ownerDigest: managementDigest(expected.owner),
    contextId: expected.contextId, commandId: expected.commandId,
    selectionDigest: managementDigest(expected.selection), anchorCommandId: expected.anchorCommandId,
  };
  if (origin.kind !== expected.kind || origin.ownerDigest !== identity.ownerDigest ||
      origin.contextId !== identity.contextId || origin.commandId !== identity.commandId ||
      origin.selectionDigest !== identity.selectionDigest ||
      managementDigest([...new Set(expected.workspaces)].sort()) !==
        managementDigest(origin.workspaces.map(row => row.path).sort())) return held();
  if ('notConsulted' in origin.approval || origin.workspaces.some(row => 'notConsulted' in row.global)) {
    const targets = expected.targets;
    if (!targets?.length || targets.length > 256 || targets.some(row => !row.providerId) ||
        managementDigest([...new Set(targets.map(row => row.workspace))].sort()) !==
          managementDigest(origin.workspaces.map(row => row.path).sort())) return held();
    for (const workspace of origin.workspaces) {
      if ('notConsulted' in workspace.global && (workspace.project.invalid ||
          targets.filter(row => row.workspace === workspace.path).some(target =>
            !workspace.project.providers.some(row => row.providerId === target.providerId)))) return held();
    }
  }
  const previous = expected.original.anchor;
  if (expected.original.present && !previous) return held();
  if (previous) {
    const { expiresAt: _cutoff, ...original } = previous;
    if (managementDigest(original) !== managementDigest(identity)) return held();
  }
  const anchor: ReadinessPreparationAnchor = previous ?? {
    ...identity, expiresAt: expected.admittedAt + input.remainingMs,
  };
  if (!Number.isSafeInteger(anchor.expiresAt) || Date.now() >= anchor.expiresAt) return held();
  return { anchor, origin };
}
