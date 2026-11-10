import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { teamCommandPath } from '../../packages/legacy-agent-host/dist/team/commandEntries.js';
import { digest } from './desktop-backend-fixture.ts';

const standardMaxBytes = 1024 * 1024;
const seededMaxBytes = 2 * 1024 * 1024;
const largeCommandId = 'TEST-large-accepted-task-comment';
const sourceName = teamCommandPath(largeCommandId).slice('commands/'.length);
const seededCommand = 'teams/test-desktop-backend/.host-owner/commands/' + sourceName;
const seededPlan = 'teams/test-desktop-backend/.host-owner/task-plans/' + sourceName;

/** Preserve exact TEST product bytes. Only the one verified 600 KiB comment
 * may create larger original Owner receipt/plan files; no other cap changes.
 */
export async function captureDesktopOwnerRoutingProduct(source: string, destination: string) {
  await mkdir(destination, { mode: 0o700 });
  const files: { path: string; sha256: string; sizeBytes: number }[] = [];
  let entries = 0;
  const walk = async (directory: string): Promise<void> => {
    const authority = /^teams\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/\.host-owner$/.test(
      directory.slice(source.length + 1)
    );
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.ok(++entries <= 2048, 'bounded offline owner product census');
      assert.ok(!entry.isSymbolicLink());
      if (
        authority &&
        /^authority\.lock(?:\.candidate-[1-9]\d*-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/.test(
          entry.name
        )
      ) {
        assert.ok(entry.isFile(), 'original authority lock is a regular file');
        continue;
      }
      if (
        authority &&
        /^authority\.lock-transition-v2(?:\.candidate-[1-9]\d*-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/.test(
          entry.name
        )
      ) {
        assert.ok(entry.isDirectory(), 'original authority gate is a directory');
        continue;
      }
      const path = join(directory, entry.name);
      assert.ok(path.startsWith(source + '/'));
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile() || entry.name === '.legacy-agent-host-writer.lock') continue;
      const relative = path.slice(source.length + 1);
      const bytes = await readFile(path);
      if (bytes.length > standardMaxBytes) {
        assert.ok(relative === seededCommand || relative === seededPlan,
          'only the captured TEST oversized comment may exceed the original evidence cap');
        assert.ok(bytes.length <= seededMaxBytes, 'bounded original oversized Owner receipt');
        const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
        assert.equal(value.commandId, largeCommandId);
        if (relative === seededCommand) {
          assert.equal(value.phase, 'completed');
          const command = value.command as Record<string, unknown>;
          assert.equal(command?.operation, 'task.comment');
          const payload = command?.payload as Record<string, unknown>;
          assert.equal(payload?.text, '漢'.repeat(200_000));
        }
      }
      const target = join(destination, relative);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      files.push({ path: relative, sha256: digest(bytes), sizeBytes: bytes.length });
    }
  };
  await walk(source);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}
