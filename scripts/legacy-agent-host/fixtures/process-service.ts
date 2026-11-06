import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFile, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

// TEST actor, reached only by the one advertised native Bash action after explicit GO.
const [rootArg, roleArg, nonceArg] = process.argv.slice(2);
assert.ok(rootArg && roleArg && nonceArg);
const root = await realpath(rootArg);
assert.ok(basename(root).startsWith('TEST-desktop-backend-'));
assert.ok(roleArg === 'primary' || roleArg === 'neighbor');
assert.match(nonceArg, /^TEST-[a-f0-9-]{36}$/);
const manifest = JSON.parse(await readFile(join(root, 'process-ui-seed.json'), 'utf8')) as {
  roles: Record<string, { nonce: string }>;
};
assert.equal(manifest.roles[roleArg]?.nonce, nonceArg);
const role = roleArg;
let closing = false;
const evidence = join(root, 'workspace', `process-${role}-lifecycle.ndjson`);
const record = async (value: Record<string, unknown>) =>
  appendFile(
    evidence,
    JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      role,
      ...value,
    }) + '\n',
    { mode: 0o600 }
  );
const server = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== `/${nonceArg}`) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ role, nonce: nonceArg, pid: process.pid }));
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert.ok(address && typeof address !== 'string');
await writeFile(
  join(root, 'workspace', `process-${role}.json`),
  JSON.stringify({
    role,
    nonce: nonceArg,
    pid: process.pid,
    port: address.port,
    url: `http://127.0.0.1:${address.port}/${nonceArg}`,
  }),
  { mode: 0o600, flag: 'wx' }
);
await record({ event: 'listening', port: address.port });
const finish = async (reason: 'natural-ttl' | 'SIGTERM') => {
  if (closing) return;
  closing = true;
  await record({ event: 'closing', reason });
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await record({ event: 'closed', reason });
  process.exitCode = 0;
};
// The finite timer is the only fallback: no numeric-PID or process-group cleanup actor.
const timer = setTimeout(() => {
  void finish('natural-ttl');
}, 300_000);
process.once('SIGTERM', () => {
  clearTimeout(timer);
  void finish('SIGTERM');
});
