import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { digest } from '../team/identity.js';
import { applyExactOpenCodeUpdatePatch } from './exactOpenCodeUpdatePatch.js';
import type { WorkspaceSnapshot } from './captureContracts.js';
import type { OpenCodeV2AfterRequest, OpenCodeV2UpdatePatchProof } from './opencodeCaptureContracts.js';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const id = (value: unknown, prefix = ''): value is string => typeof value === 'string' &&
  value.startsWith(prefix) && value.length > prefix.length && value.length <= 1024 && !/[\0\r\n]/u.test(value);
type Result = { kind: 'qualified'; file: string; lastCallId: string; proof: OpenCodeV2UpdatePatchProof } |
  { kind: 'gap'; reason: string };

/** Only the attested 2.1.4 local read/edit profile; native event sequence proves nonoverlap. */
export function qualifyOpenCodeV2FileChange(
  request: OpenCodeV2AfterRequest, workspace: string, before: WorkspaceSnapshot, after: WorkspaceSnapshot
): Result {
  try {
    if (request.dialect !== 'v2' || !request.beforeObserved || request.gapReason || request.outcome !== 'succeeded' ||
      !before.complete || !after.complete ||
      !id(request.nativeSessionId, 'ses_') || !id(request.nativeInputId, 'msg_') || !id(request.windowRef) ||
      request.items.length === 0 || request.items.length > 32) throw new Error('unqualified-v2-input-window');
    const calls = new Set<string>(), events = new Set<string>(), sequences = new Set<number>();
    let bytes = 0;
    for (const item of request.items) {
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (bytes > 1024 * 1024 || item.dialect !== 'v2' || item.protocolRevision !== '2.1.4' ||
        item.providerExecuted !== false || item.status !== 'completed' || item.completedEvent.type !== 'session.tool.success' ||
        !id(item.messageId, 'msg_') || item.messageId === request.nativeInputId || !id(item.callId) || calls.has(item.callId) ||
        !id(item.calledEvent.id) || !id(item.completedEvent.id) || item.calledEvent.id === item.completedEvent.id ||
        events.has(item.calledEvent.id) || events.has(item.completedEvent.id) ||
        !Number.isSafeInteger(item.calledEvent.seq) || item.calledEvent.seq < 0 ||
        !Number.isSafeInteger(item.completedEvent.seq) || item.completedEvent.seq <= item.calledEvent.seq ||
        sequences.has(item.calledEvent.seq) || sequences.has(item.completedEvent.seq) ||
        Object.hasOwn(item, 'partId') || Object.hasOwn(item, 'startedAt') || Object.hasOwn(item, 'completedAt'))
        throw new Error('invalid-v2-native-tool-anchor');
      calls.add(item.callId); events.add(item.calledEvent.id); events.add(item.completedEvent.id);
      sequences.add(item.calledEvent.seq); sequences.add(item.completedEvent.seq);
    }
    const ordered = [...request.items].sort((a, b) => a.calledEvent.seq - b.calledEvent.seq);
    if (ordered.some((item, index) => index > 0 && ordered[index - 1]!.completedEvent.seq >= item.calledEvent.seq))
      throw new Error('overlapping-v2-native-tools');
    let file: string | undefined, baseline: string | undefined, expected: string | undefined;
    const edits: typeof ordered = [];
    for (const item of ordered) {
      const input = record(item.input);
      if (!input || typeof input.path !== 'string') throw new Error('unsupported-v2-tool-input');
      const path = resolve(workspace, input.path), rel = relative(workspace, path);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('foreign-v2-native-path');
      if (item.tool === 'read') {
        // The existing snapshot images reject symlinks in every path component.
        // An ignored/uncaptured read has no such evidence and cannot qualify.
        for (const snapshot of [before, after]) {
          const image = snapshot.files.get(path);
          if (image?.exists !== true || image.reason || !image.content || !image.sha256)
            throw new Error('unqualified-v2-native-read-path');
        }
        continue;
      }
      if (item.tool !== 'edit') throw new Error('unsupported-v2-tool-profile');
      const metadata = record(item.metadata), files = metadata?.files;
      const diff = Array.isArray(files) && files.length === 1 ? record(files[0]) : undefined;
      if (!metadata || metadata.truncated !== false || !diff || typeof diff.file !== 'string' || resolve(workspace, diff.file) !== path ||
        diff.status !== 'modified' || typeof diff.patch !== 'string' ||
        typeof diff.additions !== 'number' || typeof diff.deletions !== 'number' ||
        typeof input.oldString !== 'string' || !input.oldString || typeof input.newString !== 'string' ||
        (input.replaceAll !== undefined && typeof input.replaceAll !== 'boolean') || (file && file !== path))
        throw new Error('unsupported-v2-native-edit');
      if (file === undefined) {
        const image = before.files.get(path);
        if (!image?.content || image.exists !== true || image.reason ||
          !Buffer.from(image.content.toString('utf8')).equals(image.content)) throw new Error('missing-v2-trusted-preimage');
        file = path; baseline = image.content.toString('utf8'); expected = baseline;
      }
      // 2.1.4's genuine metadata and patch name are workspace-relative even when
      // the actual tool input uses an absolute path. Preserve that wire spelling.
      const next = applyExactOpenCodeUpdatePatch(expected!, diff.patch, diff.file, diff.additions, diff.deletions);
      const pieces = expected!.split(input.oldString);
      if (pieces.length < 2 || (input.replaceAll !== true && pieces.length !== 2) ||
        pieces.join(input.newString) !== next || expected === next) throw new Error('v2-native-edit-byte-mismatch');
      expected = next; edits.push(item);
    }
    if (!file || !edits.length || expected === baseline) throw new Error('no-qualified-v2-edit');
    const final = after.files.get(file);
    if (!final?.content || final.exists !== true || final.reason || !final.content.equals(Buffer.from(expected!)))
      throw new Error('v2-final-byte-mismatch');
    const changed = [...new Set([...before.files.keys(), ...after.files.keys()])].filter(path => {
      const a = before.files.get(path), b = after.files.get(path);
      return !(a?.exists === false && b?.exists === false) && !(a?.sha256 && a.sha256 === b?.sha256);
    });
    if (changed.length !== 1 || changed[0] !== file) throw new Error('unexplained-v2-workspace-change');
    const tools = edits.map(item => ({ messageId: item.messageId, callId: item.callId,
      calledEventId: item.calledEvent.id, calledSeq: item.calledEvent.seq,
      completedEventId: item.completedEvent.id, completedSeq: item.completedEvent.seq }));
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    return { kind: 'qualified', file, lastCallId: tools.at(-1)!.callId, proof: {
      kind: 'opencode-update-patch-v2', protocolRevision: '2.1.4', beforeSha256: hash(baseline!), afterSha256: hash(expected!),
      toolInputDigest: digest({ nativeSessionId: request.nativeSessionId, nativeInputId: request.nativeInputId,
        windowRef: request.windowRef, items: request.items, chain: tools }),
      nativeSessionId: request.nativeSessionId, nativeInputId: request.nativeInputId, windowRef: request.windowRef, tools,
    } };
  } catch (error) { return { kind: 'gap', reason: error instanceof Error ? error.message : 'v2-patch-unavailable' }; }
}
