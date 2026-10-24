import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { qualifyOpenCodeFileChange } from '../dist/evidence/qualifyOpenCodeFileChange.js';
import type { OpenCodeAfterRequest } from '../dist/evidence/opencodeCaptureContracts.js';

const evidence = new URL('../../../docs/plans/provider-migration/evidence/p6-opencode-filechange-payload-probe-v1/', import.meta.url);
function retained() {
  const rows = readFileSync(new URL('native-events.jsonl', evidence), 'utf8').trim().split('\n').map((row) => JSON.parse(row));
  const native = rows.map((row) => row.properties?.part).find((part) => part?.type === 'tool' && part.tool === 'edit' && part.state.status === 'completed');
  assert.ok(native);
  const before = readFileSync(new URL('before.txt', evidence));
  const after = readFileSync(new URL('final.txt', evidence));
  const file: string = native.state.metadata.filediff.file;
  const image = (content: Buffer) => ({ exists: true, content, sha256: createHash('sha256').update(content).digest('hex') });
  const snapshot = (content: Buffer) => ({ complete: true, warnings: [], files: new Map([[file, image(content)]]) });
  const request: OpenCodeAfterRequest = {
    sessionRef: 'TEST-retained-session', inputId: 'TEST-host-input', operationRef: 'TEST-host-operation', windowRef: 'TEST-window', nativeSessionId: native.sessionID,
    // Read-only payload conformance only; this does not invent a Host capture of the old probe.
    nativeInputId: 'msg_TESTpayload', phase: 'after', beforeObserved: true, outcome: 'succeeded', signal: new AbortController().signal,
    items: [{ messageId: native.messageID, partId: native.id, callId: native.callID, tool: native.tool, status: native.state.status, input: native.state.input, metadata: native.state.metadata, startedAt: native.state.time.start, completedAt: native.state.time.end }],
  };
  return { request, file, workspace: dirname(file), before: snapshot(before), after: snapshot(after) };
}
test('retained real native V1 edit metadata applies exactly over its dirty preimage', () => {
  const f = retained();
  const result = qualifyOpenCodeFileChange(f.request, f.workspace, f.before, f.after);
  if (result.kind === 'gap') assert.fail(result.reason);
  assert.equal(result.lastCallId, 'TEST_native_edit_once');
  assert.deepEqual(result.proof.tools, [{messageId:f.request.items[0]!.messageId,partId:f.request.items[0]!.partId,callId:'TEST_native_edit_once'}]);
});
test('retained patch cannot authorize bytes that merely look like its final text', () => {
  const f=retained(), image=f.after.files.get(f.file)!;
  const content=Buffer.concat([image.content,Buffer.from('TEST external suffix\n')]);
  f.after.files.set(f.file,{...image,content,sha256:createHash('sha256').update(content).digest('hex')});
  assert.deepEqual(qualifyOpenCodeFileChange(f.request,f.workspace,f.before,f.after),{kind:'gap',reason:'final-byte-mismatch'});
});
