import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  readRetainedOpenDiagnostic as readOriginalDiagnostic,
  type RetainedOpenDiagnosticBinding,
  type RetainedOpenDiagnosticFiles,
} from './desktop-retained-open-diagnostics.ts';

export type { RetainedOpenDiagnosticBinding } from './desktop-retained-open-diagnostics.ts';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const FILES = ['config.json', 'team.meta.json', 'members.meta.json'] as const;
// Display labels only, not a validator or supported-record allowlist. Unknown keys are hashed.
const FIELD_LABELS = new Set([
  'version', 'runtimeSelectionVersion', 'name', 'displayName', 'description', 'color', 'cwd',
  'prompt', 'providerId', 'providerBackendId', 'model', 'effort', 'fastMode', 'worktree',
  'extraCliArgs', 'syncModelsWithLead', 'skipPermissions', 'limitContext', 'createdAt', 'updatedAt',
  'launchIdentity', 'selectedModel', 'resolvedLaunchModel', 'catalogId', 'catalogFetchedAt',
  'selectedModelKind', 'catalogSource', 'selectedEffort', 'resolvedEffort', 'fastResolutionReason',
  'billingMode', 'selectedFastMode', 'resolvedFastMode', 'members', 'agentId', 'agentType', 'role',
  'workflow', 'isolation', 'joinedAt', 'removedAt', 'isActive', 'mcpPolicy', 'mode', 'serverNames',
  'scopes', 'user', 'project', 'local', 'projectPath', 'leadAgentId', 'sessionId', 'leadSessionId',
  'sessionHistory', 'runtimeSessionId', 'nativeSessionId', 'threadId', 'runId', 'pid', 'runtimePid',
  'backendPid', 'processId', 'tmuxPaneId', 'tmuxSession', 'paneId', 'runtimeLeaseExpiresAt',
]);
type Identity = Awaited<ReturnType<RetainedOpenDiagnosticFiles['named']>>;
type Reason = 'unsafe-records' | 'record-limit' | 'changed-records' | 'invalid-records' |
  'unreadable-records' | 'summary-limit';
interface Shape {
  type: string; length?: number; keyCount?: number; items?: Shape[];
  fields?: ({ key?: string; keySha256?: string; keyLength?: number; shape: Shape })[];
  truncated?: true;
}
interface Budget { nodes: number; truncated: boolean }
const observation = { observation: 'after-original-cleanup', failureSnapshot: false } as const;
const unknown = (reason: Reason) => ({ ...observation, status: 'diagnostic-unknown', reason } as const);
class RecordRefusal extends Error {
  readonly reason: Reason;
  constructor(reason: Reason) { super(reason); this.reason = reason; }
}
const refuse: (reason: Reason) => never = reason => { throw new RecordRefusal(reason); };
const missing = (error: unknown) => error !== null && typeof error === 'object' &&
  Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT';
const same = (a: Identity, b: Identity) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
  a.uid === b.uid && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const files: RetainedOpenDiagnosticFiles = {
  owner: () => process.getuid?.(), canonical: realpath, named: path => lstat(path, { bigint: true }),
  async open(path) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return { stat: () => handle.stat({ bigint: true }),
      read: async buffer => (await handle.read(buffer, 0, buffer.length, 0)).bytesRead,
      close: () => handle.close() };
  },
};

function shape(value: unknown, budget: Budget, depth = 0): Shape {
  if (budget.nodes >= 512) { budget.truncated = true; return { type: 'truncated' }; }
  budget.nodes++;
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') return { type: 'string', length: value.length };
  if (typeof value !== 'object') return { type: typeof value };
  if (Array.isArray(value)) {
    const items: Shape[] = [];
    if (depth < 6) for (let i = 0; i < Math.min(value.length, 16) && budget.nodes < 512; i++)
      items.push(shape(value[i], budget, depth + 1));
    const truncated = items.length !== value.length;
    budget.truncated ||= truncated;
    return { type: 'array', length: value.length, items, ...(truncated ? { truncated: true } : {}) };
  }
  const keys = Object.keys(value), fields: NonNullable<Shape['fields']> = [];
  if (depth < 6) for (const key of keys.slice(0, 64)) {
    if (budget.nodes >= 512) break;
    fields.push({ ...(FIELD_LABELS.has(key) ? { key } :
      { keySha256: createHash('sha256').update(key).digest('hex'), keyLength: key.length }),
    shape: shape((value as Record<string, unknown>)[key], budget, depth + 1) });
  }
  const truncated = fields.length !== keys.length;
  budget.truncated ||= truncated;
  return { type: 'object', keyCount: keys.length, fields, ...(truncated ? { truncated: true } : {}) };
}

/** Fixed, fresh, bounded reads after cleanup. These bytes are not the earlier refusal snapshot. */
async function readShapes(root: string, io: RetainedOpenDiagnosticFiles) {
  try {
    const uid = io.owner();
    if (!Number.isSafeInteger(uid) || Number(uid) < 0) refuse('unsafe-records');
    const directories = [root, join(root, 'claude'), join(root, 'claude', 'teams'),
      join(root, 'claude', 'teams', 'test-retained-opencode-v1')];
    const parents: Identity[] = [];
    for (const path of directories) {
      const named = await io.named(path);
      if (!named.isDirectory() || named.isSymbolicLink() || named.uid !== BigInt(uid!) ||
          await io.canonical(path) !== path) refuse('unsafe-records');
      parents.push(named);
    }
    if ((parents[0]!.mode & 0o077n) !== 0n) refuse('unsafe-records');
    const budget: Budget = { nodes: 0, truncated: false };
    const identities: { path: string; named?: Identity }[] = [];
    const records: { file: string; status: 'observed' | 'missing'; bytes?: number; shape?: Shape }[] = [];
    for (const file of FILES) {
      const path = join(directories[3]!, file);
      let named: Identity;
      try { named = await io.named(path); }
      catch (error) {
        if (!missing(error)) throw error;
        identities.push({ path }); records.push({ file, status: 'missing' }); continue;
      }
      if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n ||
          named.uid !== BigInt(uid!) || await io.canonical(path) !== path) refuse('unsafe-records');
      if (named.size < 0n || named.size > BigInt(MAX_FILE_BYTES)) refuse('record-limit');
      const handle = await io.open(path);
      let value: unknown;
      try {
        if (!same(named, await handle.stat())) refuse('changed-records');
        const buffer = Buffer.alloc(Number(named.size) + 1), count = await handle.read(buffer);
        if (count !== Number(named.size) || !same(named, await handle.stat()) ||
            !same(named, await io.named(path))) refuse('changed-records');
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count))); }
        catch { refuse('invalid-records'); }
      } finally { await handle.close(); }
      identities.push({ path, named });
      records.push({ file, status: 'observed', bytes: Number(named.size), shape: shape(value, budget) });
    }
    for (let i = 0; i < directories.length; i++)
      if (!same(parents[i]!, await io.named(directories[i]!))) refuse('changed-records');
    for (const item of identities) {
      let now: Identity | undefined;
      try { now = await io.named(item.path); } catch (error) { if (!missing(error)) throw error; }
      if (item.named ? !now || !same(item.named, now) : now !== undefined) refuse('changed-records');
    }
    return { ...observation, status: 'observed', records, ...budget } as const;
  } catch (error) { return unknown(error instanceof RecordRefusal ? error.reason : 'unreadable-records'); }
}

/** Preserve the existing single log read; additional observation is only for this correlated failure. */
export async function readRetainedOpenDiagnostic(input: {
  root: string | undefined; binding: RetainedOpenDiagnosticBinding | undefined;
}, io?: RetainedOpenDiagnosticFiles) {
  const diagnostic = await readOriginalDiagnostic(input, io);
  if (diagnostic.status !== 'observed' || diagnostic.category !== 'source-unreadable' ||
      diagnostic.sourceBoundary !== 'product-records') return diagnostic;
  try {
    const result = { ...diagnostic, productRecordShapes: await readShapes(input.root!, io ?? files) };
    return Buffer.byteLength(JSON.stringify(result)) <= MAX_OUTPUT_BYTES ? result :
      { ...diagnostic, productRecordShapes: unknown('summary-limit') };
  } catch { return { ...diagnostic, productRecordShapes: unknown('unreadable-records') }; }
}
