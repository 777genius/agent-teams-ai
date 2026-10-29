import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const [supplied] = process.argv.slice(2);
assert.ok(supplied && process.argv.length === 3);
const root = await realpath(supplied);
assert.ok(basename(root).startsWith('TEST-desktop-backend-'));
const seed = JSON.parse(await readFile(join(root, 'process-ui-seed.json'), 'utf8')) as { node: string };
assert.equal(await realpath(process.execPath), seed.node);
const children = (['primary', 'neighbor'] as const).map(role => {
  const child = spawn(seed.node, [join(root, 'workspace/process-foreground-service.ts'), root, role], {
    cwd: root, stdio: ['ignore', 'ignore', 'inherit'], detached: false,
  });
  const facts = { role, pid: child.pid, exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null, cleanupSignals: 0, error: undefined as string | undefined };
  const closed = new Promise<void>(resolve => {
    child.once('error', error => { facts.error = error.message; resolve(); });
    child.once('exit', (code, signal) => { facts.exitCode = code; facts.signalCode = signal; resolve(); });
  });
  return { child, facts, closed };
});
let closing: Promise<void> | undefined;
const close = () => closing ??= (async () => {
  for (const { child, facts } of children) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null && !facts.error) {
      facts.cleanupSignals++;
      assert.equal(child.kill('SIGTERM'), true, 'only the original retained live child handle');
    }
  }
  await Promise.all(children.map(value => value.closed));
  await writeFile(join(root, 'controlled-process-root-result.json'), JSON.stringify({
    rootPid: process.pid, children: children.map(value => value.facts),
    scope: 'Original retained TEST ChildProcess handles only; no numeric/group lookup, adoption or Stop replay',
  }, null, 2), { mode: 0o600, flag: 'wx' });
  process.stdin.pause();
  clearTimeout(timer);
  if (children.some(value => value.facts.error || value.facts.exitCode !== 0 || value.facts.signalCode !== null))
    process.exitCode = 1;
})();
// The services keep their unchanged 300s TTL. This original wrapper is also finite.
const timer = setTimeout(() => { void close().catch(fail); }, 305_000);
function fail(error: unknown) {
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
  clearTimeout(timer);
  process.stdin.pause();
}
process.stdin.once('end', () => { void close().catch(fail); });
process.stdin.resume();
