import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Invoked once through the real advertised Bash tool. No setsid/nohup/detached child.
const [rootArg] = process.argv.slice(2);
assert.ok(rootArg);
const root = await realpath(rootArg);
assert.ok(basename(root).startsWith('TEST-desktop-backend-'));
const seed = JSON.parse(await readFile(join(root, 'process-ui-seed.json'), 'utf8')) as {
  node: string;
  roles: Record<string, { nonce: string }>;
};
assert.equal(await realpath(process.execPath), seed.node);
await writeFile(
  join(root, 'workspace', 'process-bootstrap-attempted.json'),
  JSON.stringify({
    pid: process.pid,
    at: new Date().toISOString(),
  }),
  { mode: 0o600, flag: 'wx' }
);
for (const role of ['primary', 'neighbor']) {
  const child = spawn(
    seed.node,
    [join(root, 'workspace', 'process-service.ts'), root, role, seed.roles[role]!.nonce],
    {
      cwd: join(root, 'workspace'),
      detached: false,
      stdio: 'ignore',
      env: {
        HOME: join(root, 'native-claude/home'),
        TMPDIR: join(root, 'native-claude/tmp'),
        PATH: `${dirname(seed.node)}:/usr/bin:/bin`,
      },
    }
  );
  await new Promise<void>((done, reject) => {
    child.once('spawn', done);
    child.once('error', reject);
  });
  child.unref();
}
const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  const rows = await Promise.all(
    ['primary', 'neighbor'].map(async (role) => {
      try {
        return JSON.parse(
          await readFile(join(root, 'workspace', `process-${role}.json`), 'utf8')
        ) as unknown;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    })
  );
  if (rows.every(Boolean)) {
    console.log(JSON.stringify({ services: rows }));
    process.exitCode = 0;
    break;
  }
  await delay(25);
}
assert.ok(
  Date.now() < deadline,
  'finite TEST services must publish their own original listener nonces'
);
