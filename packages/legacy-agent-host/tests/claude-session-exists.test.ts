import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { claudeSessionExists } from '../dist/adapters/providers/claudeSessionExists.js';

const sessionId = 'TEST-session-native-identity';
const row = (cwd: string, override: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'user',
    sessionId,
    cwd,
    isSidechain: false,
    message: { role: 'user', content: 'TEST' },
    ...override,
  }) + '\n';

test('selected Claude history handles hashed/custom project directories and later cwd changes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-claude-history-')));
  try {
    const namespace = join(root, 'config');
    const cwd = join(root, 'workspace');
    const project = join(namespace, 'projects', 'custom-or-hashed-key');
    await mkdir(project, { recursive: true });
    await mkdir(cwd);
    await writeFile(
      join(project, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'queue-operation' }) + '\n' + row(cwd) + row(join(root, 'later-cwd'))
    );
    assert.equal(claudeSessionExists(namespace, cwd, sessionId), true);
    assert.equal(claudeSessionExists(namespace, cwd, '../escape'), false);
    assert.equal(claudeSessionExists(namespace, cwd, 'unrecorded-session'), false);
    const duplicate = join(namespace, 'projects', 'second-project');
    await mkdir(duplicate);
    await writeFile(join(duplicate, `${sessionId}.jsonl`), row(cwd));
    assert.equal(
      claudeSessionExists(namespace, cwd, sessionId),
      false,
      'ambiguous history is never guessed'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude history rejects unrelated identity, malformed/oversized rows and symlink escapes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-claude-history-refuse-')));
  try {
    const namespace = join(root, 'config');
    const cwd = join(root, 'workspace');
    const project = join(namespace, 'projects', 'selected-key');
    await mkdir(project, { recursive: true });
    await mkdir(cwd);
    const file = join(project, `${sessionId}.jsonl`);
    for (const content of [
      row(join(root, 'different-origin')),
      row(cwd, { sessionId: 'other-session' }),
      row(cwd, { isSidechain: true }),
      '{malformed\n',
      'x'.repeat(1024 * 1024 + 1),
    ]) {
      await writeFile(file, content);
      assert.equal(claudeSessionExists(namespace, cwd, sessionId), false);
    }
    const outside = join(root, 'outside.jsonl');
    await writeFile(outside, row(cwd));
    await rm(file);
    await symlink(outside, file);
    assert.equal(claudeSessionExists(namespace, cwd, sessionId), false);
    await rm(file);
    await rm(project, { recursive: true });
    const outsideProject = join(root, 'outside-project');
    await mkdir(outsideProject);
    await writeFile(join(outsideProject, `${sessionId}.jsonl`), row(cwd));
    await symlink(outsideProject, project);
    assert.equal(claudeSessionExists(namespace, cwd, sessionId), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
