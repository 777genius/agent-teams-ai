import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
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
export async function checkpoint(root: string, session: Record<string, unknown>, provider: 'claude' | 'codex' = 'claude') {
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
  const opaque = record(payload.opaque);
  const nativeSession = provider === 'codex' ? opaque.nativeThreadId : opaque.nativeSession;
  assert.match(String(nativeSession), /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  if (provider === 'codex') {
    assert.equal(opaque.engine, 'codex-app-server'); assert.equal(opaque.version, 2);
    const { historyPath, history } = await codexHistory(root, session, String(nativeSession));
    return { attempt, payload, path, nativeSession, historyPath, history,
      historySha256: digest(history), payloadFileSha256: digest(await readFile(path)) };
  }
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

export function originalHistoryMarker(toolIds: readonly string[], provider: 'claude' | 'codex' = 'claude'): string {
  assert.deepEqual(toolIds, Array.from({ length: 7 }, (_, index) => `native_${provider === 'codex' ? 'CODEX' : 'NATIVE'}_TEAM_ONE_${index}`));
  return jsonDigest(toolIds);
}

/** Exact private captured namespace and native metadata identity; never a filename-only fallback. */
async function codexHistory(root: string, session: Record<string, unknown>, nativeThreadId: string) {
  assert.match(root, /\/TEST-desktop-backend-[^/]+$/);
  assert.equal(await realpath(root), root);
  const profile = await json(join(root, 'host-profile.json'));
  const binding = record(session.binding);
  const members = (record(profile.runtime).members as unknown[]).map(record).filter(member =>
    member.provider === 'codex' && member.teamId === binding.teamId && member.memberId === binding.memberId);
  assert.equal(members.length, 1, 'one exact captured Codex member namespace');
  const member = members[0]!, config = join(root, 'native-codex/config'), cwd = join(root, 'workspace');
  assert.equal(record(member.environment).CODEX_HOME, config);
  assert.equal(member.cwd, cwd); assert.equal(await realpath(config), config);
  assert.equal(await realpath(cwd), cwd);
  let directories = 0, files = 0;
  const matches: { historyPath: string; history: Buffer }[] = [];
  const walk = async (parent: string, depth: number): Promise<void> => {
    assert.equal(await realpath(parent), parent);
    assert.ok(++directories <= 32, 'bounded captured native session directories');
    const children = await readdir(parent, { withFileTypes: true });
    assert.ok(children.length <= 128);
    for (const child of children) {
      assert.equal(child.isSymbolicLink(), false);
      const path = join(parent, child.name);
      if (child.isDirectory()) {
        assert.ok(depth < 3 && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(child.name));
        await walk(path, depth + 1);
      } else {
        assert.ok(child.isFile() && ++files <= 128);
        if (!child.name.endsWith(`-${nativeThreadId}.jsonl`)) continue;
        const info = await lstat(path);
        assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 16 * 1024 * 1024);
        const history = await readFile(path);
        const first = history.toString('utf8').split('\n', 1)[0]!;
        assert.ok(Buffer.byteLength(first) <= 512 * 1024);
        const metadata = record(JSON.parse(first));
        assert.equal(metadata.type, 'session_meta');
        assert.equal(record(metadata.payload).id, nativeThreadId);
        assert.equal(record(metadata.payload).cwd, cwd);
        matches.push({ historyPath: path, history });
      }
    }
  };
  await walk(join(config, 'sessions'), 0);
  assert.equal(matches.length, 1, 'one exact original native Codex history backing');
  return matches[0]!;
}
