import { resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { digest } from '../team/identity.js';
import { applyExactCodexUpdatePatch } from './exactCodexUpdatePatch.js';
import type {
  CodexAfterRequest,
  CodexCaptureItem,
  CodexUpdatePatchProof,
} from './codexCaptureContracts.js';
import type { WorkspaceSnapshot } from './captureContracts.js';
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/u.test(value);
export type CodexPatchQualification =
  | { kind: 'qualified'; file: string; lastItemId: string; proof: CodexUpdatePatchProof }
  | { kind: 'gap'; reason: string };
/** First bounded native qualification: one text update path, possibly an ordered same-path chain. */
export function qualifyCodexFileChange(
  request: CodexAfterRequest,
  workspace: string,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot
): CodexPatchQualification {
  try {
    if (
      !request.beforeObserved ||
      request.gapReason ||
      request.outcome !== 'completed' ||
      ![request.windowRef, request.threadId, request.turnId].every(validId) ||
      request.items.length === 0 ||
      request.items.length > 64
    )
      throw new Error('unqualified-input-window');
    const completed: CodexCaptureItem[] = [];
    let started: CodexCaptureItem | undefined;
    const seen = new Set<string>();
    let bytes = 0;
    for (const item of request.items) {
      if (!validId(item.itemId)) throw new Error('invalid-item');
      bytes += Buffer.byteLength(JSON.stringify(item.changes));
      if (bytes > 1024 * 1024) throw new Error('patch-cap');
      if (item.phase === 'started') {
        if (started || seen.has(item.itemId) || item.status !== 'inProgress')
          throw new Error('overlapping-or-duplicate-items');
        started = item;
        seen.add(item.itemId);
      } else {
        if (
          !started ||
          item.status !== 'completed' ||
          started.itemId !== item.itemId ||
          digest(started.changes) !== digest(item.changes)
        )
          throw new Error('item-pair-mismatch');
        completed.push(item);
        started = undefined;
      }
    }
    if (started || !completed.length) throw new Error('incomplete-item-pair');
    let file: string | undefined, expected: string | undefined, baseline: string | undefined;
    for (const item of completed) {
      if (!Array.isArray(item.changes) || item.changes.length !== 1)
        throw new Error('unsupported-multi-file-item');
      const change = record(item.changes[0]),
        kind = record(change?.kind);
      if (
        !change ||
        typeof change.path !== 'string' ||
        change.path.includes('\0') ||
        kind?.type !== 'update' ||
        kind.move_path !== null ||
        typeof change.diff !== 'string'
      )
        throw new Error('unsupported-change');
      const path = resolve(workspace, change.path);
      const rel = relative(workspace, path);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error('outside-workspace');
      if (file && file !== path) throw new Error('unsupported-multi-file-chain');
      if (!file) {
        const image = before.files.get(path);
        if (!image?.content || image.exists !== true || image.reason)
          throw new Error('missing-trusted-preimage');
        file = path;
        baseline = image.content.toString('utf8');
        expected = baseline;
      }
      expected = applyExactCodexUpdatePatch(expected!, change.diff);
    }
    const image = after.files.get(file!);
    if (
      !image?.content ||
      image.exists !== true ||
      image.reason ||
      image.content.toString('utf8') !== expected
    )
      throw new Error('final-byte-mismatch');
    const changed = [...new Set([...before.files.keys(), ...after.files.keys()])].filter((path) => {
      const old = before.files.get(path),
        next = after.files.get(path);
      return (
        !(old?.exists === false && next?.exists === false) &&
        !(old?.sha256 && old.sha256 === next?.sha256)
      );
    });
    if (changed.length !== 1 || changed[0] !== file || baseline === expected)
      throw new Error('unexplained-workspace-change');
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    return {
      kind: 'qualified',
      file: file!,
      lastItemId: completed.at(-1)!.itemId,
      proof: {
        kind: 'codex-update-patch-v1',
        beforeSha256: hash(baseline!),
        afterSha256: hash(expected!),
        toolInputDigest: digest({
          threadId: request.threadId,
          turnId: request.turnId,
          items: completed,
        }),
        threadId: request.threadId,
        turnId: request.turnId,
        windowRef: request.windowRef,
        itemIds: completed.map((item) => item.itemId),
      },
    };
  } catch (error) {
    return { kind: 'gap', reason: error instanceof Error ? error.message : 'patch-unavailable' };
  }
}
