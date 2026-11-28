import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { digest } from '../team/identity.js';
import { applyExactOpenCodeUpdatePatch } from './exactOpenCodeUpdatePatch.js';
import type { WorkspaceSnapshot } from './captureContracts.js';
import type { OpenCodeAfterRequest, OpenCodeCaptureItem, OpenCodeUpdatePatchProof } from './opencodeCaptureContracts.js';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const id = (value: unknown, prefix = ''): value is string =>
  typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length && value.length <= 1024 && !/[\0\r\n]/u.test(value);
type Edit = { item: OpenCodeCaptureItem; patch: string; additions: number; deletions: number; input: Record<string, unknown> };
type Result = { kind: 'qualified'; file: string; lastCallId: string; proof: OpenCodeUpdatePatchProof } | { kind: 'gap'; reason: string };

/** Byte-chain order is derived from exact preimages, never native timestamps or transcript position. */
export function qualifyOpenCodeFileChange(request: OpenCodeAfterRequest, workspace: string, before: WorkspaceSnapshot, after: WorkspaceSnapshot): Result {
  try {
    if (!request.beforeObserved || request.gapReason || request.outcome !== 'succeeded' || !id(request.nativeSessionId, 'ses_') || !id(request.nativeInputId, 'msg_') || !id(request.windowRef) || !request.items.length || request.items.length > 32)
      throw new Error('unqualified-input-window');
    const parts = new Set<string>(), calls = new Set<string>(), edits: Edit[] = [];
    let file: string | undefined, bytes = 0;
    for (const item of request.items) {
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (bytes > 1024 * 1024) throw new Error('patch-cap');
      if (!id(item.messageId, 'msg_') || item.messageId === request.nativeInputId || !id(item.partId, 'prt_') || !id(item.callId) || parts.has(item.partId) || calls.has(item.callId) || item.status !== 'completed')
        throw new Error('invalid-tool-anchor');
      parts.add(item.partId); calls.add(item.callId);
      if (item.tool === 'read') {
        const input = record(item.input);
        if (!input || typeof input.filePath !== 'string') throw new Error('unsupported-read');
        const rel = relative(workspace, resolve(workspace, input.filePath));
        if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('foreign-read');
        continue;
      }
      // Other native tools have no authored-effect qualification in this first profile.
      if (item.tool !== 'edit') throw new Error('unsupported-tool-profile');
      const input = record(item.input), metadata = record(item.metadata), diff = record(metadata?.filediff);
      if (!input || !metadata || !diff || metadata.truncated !== false || typeof input.filePath !== 'string' || typeof diff.file !== 'string' || typeof diff.patch !== 'string' || typeof diff.additions !== 'number' || typeof diff.deletions !== 'number' || typeof input.oldString !== 'string' || !input.oldString || typeof input.newString !== 'string' || (input.replaceAll !== undefined && typeof input.replaceAll !== 'boolean'))
        throw new Error('unsupported-native-edit');
      const path = resolve(workspace, input.filePath), rel = relative(workspace, path);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || diff.file !== path || (file && path !== file))
        throw new Error('foreign-or-multiple-paths');
      if (metadata.diff !== undefined && metadata.diff !== diff.patch) throw new Error('conflicting-native-patch');
      file = path;
      edits.push({ item, input, patch: diff.patch, additions: diff.additions, deletions: diff.deletions });
    }
    // Timestamps are only a negative overlap guard. Missing or overlapping multi-tool
    // intervals cannot establish a foreground serial profile, regardless of byte match.
    if (edits.length > 1) for (let i = 0; i < edits.length; i++) {
      const a = edits[i]!.item;
      if (!Number.isSafeInteger(a.startedAt) || !Number.isSafeInteger(a.completedAt) || a.startedAt! < 0 || a.completedAt! <= a.startedAt!) throw new Error('unqualified-tool-interval');
      for (const b of edits.slice(i + 1).map((edit) => edit.item))
        if (b.startedAt === null || b.completedAt === null || Math.max(a.startedAt!, b.startedAt) <= Math.min(a.completedAt!, b.completedAt)) throw new Error('overlapping-tool-intervals');
    }
    if (!edits.length) throw new Error('no-qualified-edit');
    const image = before.files.get(file!);
    if (!image?.content || image.exists !== true || image.reason || !Buffer.from(image.content.toString('utf8')).equals(image.content)) throw new Error('missing-trusted-preimage');
    const baseline = image.content.toString('utf8');
    let expected = baseline;
    const remaining = [...edits], chain: Edit[] = [];
    while (remaining.length) {
      const matches: { edit: Edit; next: string }[] = [];
      for (const edit of remaining) try {
        const next = applyExactOpenCodeUpdatePatch(expected, edit.patch, file!, edit.additions, edit.deletions);
        const pieces = expected.split(edit.input.oldString as string);
        if (pieces.length < 2 || (edit.input.replaceAll !== true && pieces.length !== 2) || pieces.join(edit.input.newString as string) !== next || next === expected) continue;
        matches.push({ edit, next });
      } catch { /* A patch may target the next intermediate image, never a fuzzy match. */ }
      if (matches.length !== 1) throw new Error('ambiguous-or-broken-patch-chain');
      const selected = matches[0]!;
      expected = selected.next; chain.push(selected.edit); remaining.splice(remaining.indexOf(selected.edit), 1);
    }
    const final = after.files.get(file!);
    if (!final?.content || final.exists !== true || final.reason || !final.content.equals(Buffer.from(expected))) throw new Error('final-byte-mismatch');
    const changed = [...new Set([...before.files.keys(), ...after.files.keys()])].filter((path) => {
      const a = before.files.get(path), b = after.files.get(path);
      return !(a?.exists === false && b?.exists === false) && !(a?.sha256 && a.sha256 === b?.sha256);
    });
    if (changed.length !== 1 || changed[0] !== file || baseline === expected) throw new Error('unexplained-workspace-change');
    const tools = chain.map(({ item }) => ({ messageId: item.messageId, partId: item.partId, callId: item.callId }));
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    return { kind: 'qualified', file: file!, lastCallId: tools.at(-1)!.callId, proof: {
      kind: 'opencode-update-patch-v1', beforeSha256: hash(baseline), afterSha256: hash(expected), toolInputDigest: digest({ nativeSessionId: request.nativeSessionId, nativeInputId: request.nativeInputId, windowRef: request.windowRef, items: request.items, chain: tools }), nativeSessionId: request.nativeSessionId, nativeInputId: request.nativeInputId, windowRef: request.windowRef, tools,
    } };
  } catch (error) { return { kind: 'gap', reason: error instanceof Error ? error.message : 'patch-unavailable' }; }
}
