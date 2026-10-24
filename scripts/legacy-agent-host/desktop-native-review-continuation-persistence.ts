import assert from 'node:assert/strict';
import { buildReviewChunkContextHashes } from '@agent-teams/task-change-ledger/review-text';
type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
/** Only production-derived cache enrichment may differ across a read-only reload. */
export function assertNativeReviewPersistence(
  before: Row[],
  after: Row[],
  source: { filePath: string; before: string; after: string }
): { contextEnriched: boolean } {
  assert.equal(before.length, 1);
  assert.equal(after.length, 1);
  const previous = before[0]!,
    current = after[0]!;
  assert.deepEqual(Object.keys(previous).sort(), ['path', 'sha256', 'value']);
  assert.deepEqual(Object.keys(current).sort(), ['path', 'sha256', 'value']);
  assert.equal(current.path, previous.path);
  assert.match(String(previous.sha256), /^[a-f0-9]{64}$/);
  assert.match(String(current.sha256), /^[a-f0-9]{64}$/);
  const a = record(previous.value),
    b = record(current.value),
    key = `path:${source.filePath}`;
  const expected = buildReviewChunkContextHashes(source.before, source.after);
  assert.equal(Object.keys(expected).length, 2, 'exact retained two-hunk source');
  const {
    hunkContextHashesByFile: oldCache,
    revision: oldRevision,
    updatedAt: oldTime,
    ...oldState
  } = a;
  const {
    hunkContextHashesByFile: newCache,
    revision: newRevision,
    updatedAt: newTime,
    ...newState
  } = b;
  assert.deepEqual(
    newState,
    oldState,
    'decisions/history IDs/redo/blobs/scope/authority fields remain exact'
  );
  assert.deepEqual(Object.keys(record(oldCache)), [key]);
  assert.deepEqual(Object.keys(record(newCache)), [key]);
  const oldHashes = record(record(oldCache)[key]),
    newHashes = record(record(newCache)[key]);
  for (const [index, hash] of Object.entries(oldHashes)) {
    assert.ok(Object.hasOwn(expected, index), 'canonical exact hunk index only');
    assert.equal(hash, expected[Number(index)]);
  }
  if (JSON.stringify(current) === JSON.stringify(previous)) return { contextEnriched: false };
  assert.deepEqual(
    newHashes,
    expected,
    'only exact CodeMirror hashes derived from retained native bytes are admitted'
  );
  const enriched = Object.keys(oldHashes).length < Object.keys(expected).length;
  assert.ok(enriched, 'no unrelated revision, timestamp or byte drift without enrichment');
  assert.ok(Number.isSafeInteger(oldRevision) && Number.isSafeInteger(newRevision));
  assert.equal(newRevision, Number(oldRevision) + 1);
  assert.equal(typeof oldTime, 'string');
  assert.equal(typeof newTime, 'string');
  const from = Date.parse(String(oldTime)),
    to = Date.parse(String(newTime));
  assert.ok(Number.isFinite(from) && Number.isFinite(to) && to >= from);
  assert.equal(new Date(from).toISOString(), oldTime);
  assert.equal(new Date(to).toISOString(), newTime);
  assert.notEqual(current.sha256, previous.sha256);
  return { contextEnriched: enriched };
}
