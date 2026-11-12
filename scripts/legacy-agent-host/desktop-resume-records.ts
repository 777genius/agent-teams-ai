import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
export async function checkpoint(root: string, session: Record<string, unknown>, provider: 'claude' | 'codex' | 'opencode' = 'claude') {
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
  if (provider === 'opencode') {
    assert.deepEqual(Object.keys(opaque).sort(), ['compatibility', 'engine', 'nativeSessionId', 'version']);
    assert.equal(opaque.engine, 'opencode-v2'); assert.equal(opaque.version, 1);
    assert.match(String(opaque.compatibility), /^[a-f0-9]{64}$/);
    const nativeSession = String(opaque.nativeSessionId);
    assert.match(nativeSession, /^ses_[a-f0-9]{40}$/);
    const { historyPath, history } = await openCodeHistory(root, session, nativeSession);
    return { attempt, payload, path, nativeSession, historyPath, history,
      historySha256: digest(history), payloadFileSha256: digest(await readFile(path)) };
  }
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

export function originalHistoryMarker(toolIds: readonly string[], provider: 'claude' | 'codex' | 'opencode' = 'claude'): string {
  const prefix = provider === 'opencode' ? 'TEST_OPENCODE' : `native_${provider === 'codex' ? 'CODEX' : 'NATIVE'}`;
  assert.deepEqual(toolIds, Array.from({ length: 7 }, (_, index) => `${prefix}_TEAM_ONE_${index}`));
  return jsonDigest(toolIds);
}

/** Exact captured V2 SQLite log, opened read-only only after the original Runtime released it. */
async function openCodeHistory(root: string, session: Record<string, unknown>, nativeSession: string) {
  assert.match(root, /\/TEST-desktop-backend-[^/]+$/); assert.equal(await realpath(root), root);
  assert.equal(session.phase, 'closed'); assert.equal(session.custody, 'released');
  const profile = await json(join(root, 'host-profile.json')), binding = record(session.binding);
  const members = (record(profile.runtime).members as unknown[]).map(record).filter(member =>
    member.provider === 'opencode' && member.teamId === binding.teamId && member.memberId === binding.memberId);
  assert.equal(members.length, 1);
  const member = members[0]!, config = record(session.config), cwd = join(root, 'workspace');
  assert.equal(member.nativeGeneration, 'v2'); assert.equal(member.protocolRevision, '2.1.4');
  assert.equal(member.cwd, cwd); assert.equal(await realpath(cwd), cwd);
  assert.equal(typeof config.sessionId, 'string');
  assert.equal(nativeSession, 'ses_' + jsonDigest({ sessionId: config.sessionId,
    memberId: member.memberId, accountBinding: member.accountBinding }).slice(0, 40));
  const data = String(record(member.environment).XDG_DATA_HOME);
  assert.equal(data, join(root, 'providers/opencode-v2/data'));
  assert.equal(await realpath(data), data);
  const namespace = 'agent-teams-v2-' + jsonDigest({
    teamId: member.teamId, memberId: member.memberId, sessionId: config.sessionId,
  }).slice(0, 32);
  const directory = join(data, namespace), historyPath = join(directory, 'opencode.sqlite');
  assert.equal(await realpath(directory), directory); assert.equal(await realpath(historyPath), historyPath);
  const before = await lstat(historyPath);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= 64 * 1024 * 1024);
  const database = new DatabaseSync(historyPath, { readOnly: true });
  let history: Buffer;
  try {
    const selected = database.prepare('SELECT id, directory, version FROM session_v2 WHERE id = ?').all(nativeSession);
    assert.equal(selected.length, 1); assert.equal(selected[0]!.directory, cwd); assert.equal(selected[0]!.version, '2.1.4');
    const events = database.prepare('SELECT id, aggregate_id, seq, type, data FROM event WHERE aggregate_id = ? ORDER BY seq LIMIT 4097').all(nativeSession);
    assert.ok(events.length > 0 && events.length <= 4096);
    let prior = -1;
    for (const event of events) {
      assert.equal(event.aggregate_id, nativeSession); assert.ok(Number.isSafeInteger(event.seq) && Number(event.seq) > prior);
      prior = Number(event.seq); assert.equal(typeof event.data, 'string');
    }
    history = Buffer.from(events.map(event => JSON.stringify(event) + '\n').join(''));
    assert.ok(history.length <= 16 * 1024 * 1024);
  } finally { database.close(); }
  const after = await lstat(historyPath);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const) assert.equal(after[key], before[key]);
  return { historyPath, history };
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
