import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const record = (raw: unknown): Record<string, unknown> => {
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
  return raw as Record<string, unknown>;
};
export const digest = (raw: string | Uint8Array): string => createHash('sha256').update(raw).digest('hex');
export const jsonDigest = (raw: unknown): string => digest(JSON.stringify(raw));
export async function json(path: string): Promise<Record<string, unknown>> {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024);
  return record(JSON.parse(await readFile(path, 'utf8')));
}
export async function rows(path: string): Promise<Record<string, unknown>[]> {
  const entries = await readdir(path, { withFileTypes: true });
  assert.ok(entries.length <= 256 && entries.every(entry => entry.isFile() && /^[A-Za-z0-9_-]+\.json$/.test(entry.name)));
  return Promise.all(entries.map(entry => json(join(path, entry.name))));
}

/** Private TEST evidence only. Reads the exact published payload, never creates a checkpoint. */
export async function checkpoint(root: string, session: Record<string, unknown>) {
  const published = (session.checkpoints as unknown[]).map(record).filter(row => row.status === 'published');
  assert.equal(published.length, 1, 'one explicit original Stop checkpoint');
  const attempt = published[0]!;
  assert.match(String(attempt.reference), /^cp1-[a-f0-9]{64}$/);
  const path = join(root, 'hoststore/runtime-checkpoints', `${attempt.reference}.json`);
  const payload = await json(path);
  const { digest: expected, ...body } = payload;
  assert.equal(jsonDigest(body), expected, 'checkpoint payload digest');
  assert.equal(expected, attempt.payloadDigest);
  assert.equal(payload.historyDigest, attempt.historyDigest);
  assert.equal(payload.sourceSessionRef, session.sessionRef);
  assert.deepEqual(payload.sourceBinding, session.binding);
  assert.deepEqual(payload.sourceConfig, session.config);
  const operations = (session.inputs as unknown[]).map(record).filter(input => input.phase === 'terminal').map(input => ({
    inputId: record(input.intent).inputId, operationRef: input.operationRef,
    fingerprint: input.fingerprint, outcome: input.terminal,
  }));
  assert.deepEqual(payload.completedOperations, operations);
  assert.equal(payload.historyDigest, jsonDigest({ baseline: record(session.config).checkpointRef ?? null, operations }));
  assert.equal(payload.reference, `cp1-${jsonDigest({ binding: session.binding, checkpointId: payload.checkpointId })}`);
  const nativeSession = record(payload.opaque).nativeSession;
  assert.match(String(nativeSession), /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  // Native backing is read strictly below this fixture's private captured Claude config.
  const projects = join(root, 'native-claude/config/projects');
  const directories = await readdir(projects, { withFileTypes: true });
  assert.ok(directories.length <= 32 && directories.every(entry => entry.isDirectory() && !entry.isSymbolicLink()));
  const matches: string[] = [];
  for (const directory of directories) {
    const parent = join(projects, directory.name);
    const children = await readdir(parent, { withFileTypes: true });
    assert.ok(children.length <= 128);
    for (const child of children) if (child.name === `${nativeSession}.jsonl`) {
      assert.ok(child.isFile() && !child.isSymbolicLink());
      matches.push(join(parent, child.name));
    }
  }
  assert.equal(matches.length, 1, 'exact original native history backing, no alternate fallback');
  const historyPath = matches[0]!;
  const info = await lstat(historyPath);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 16 * 1024 * 1024);
  const history = await readFile(historyPath);
  return { attempt, payload, path, nativeSession, historyPath, history,
    historySha256: digest(history), payloadFileSha256: digest(await readFile(path)) };
}

export function originalHistoryMarker(toolIds: readonly string[]): string {
  assert.deepEqual(toolIds, Array.from({ length: 7 }, (_, index) => `native_NATIVE_TEAM_ONE_${index}`));
  return jsonDigest(toolIds);
}
