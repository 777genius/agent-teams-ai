import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFile, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
const startedAt = Date.now(),
  ttlMs = 300_000;
const [supplied, selectedRole] = process.argv.slice(2);
assert.ok(supplied);
assert.ok(selectedRole === 'primary' || selectedRole === 'neighbor');
const root = await realpath(supplied);
assert.ok(basename(root).startsWith('TEST-desktop-backend-'));
const seed = JSON.parse(await readFile(join(root, 'process-ui-seed.json'), 'utf8')) as {
  node: string;
  roles: Record<string, { nonce: string }>;
};
assert.equal(await realpath(process.execPath), seed.node);
const role = selectedRole,
  nonce = seed.roles[role]!.nonce;
assert.match(nonce, /^TEST-[a-f0-9-]{36}$/);
const lifecycle = join(root, `workspace/process-${role}-lifecycle.ndjson`);
const record = (value: Record<string, unknown>) =>
  appendFile(
    lifecycle,
    JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      role,
      ...value,
    }) + '\n',
    { mode: 0o600 }
  );
const server = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/' + nonce) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ role, nonce, pid: process.pid }));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
await writeFile(
  join(root, `workspace/process-${role}.json`),
  JSON.stringify({
    role,
    nonce,
    pid: process.pid,
    port: address.port,
    url: `http://127.0.0.1:${address.port}/${nonce}`,
  }),
  { mode: 0o600, flag: 'wx' }
);
await record({ event: 'listening', port: address.port, ttlMs, startedAt });
let closing = false;
const close = async (reason: string) => {
  if (closing) return;
  closing = true;
  await record({ event: 'closing', reason });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await record({ event: 'closed', reason });
  process.exitCode = 0;
};
const timer = setTimeout(
  () => {
    void close('natural-ttl');
  },
  Math.max(0, startedAt + ttlMs - Date.now())
);
process.once('SIGTERM', () => {
  clearTimeout(timer);
  void close('SIGTERM');
});
// Foreground server: no spawn, unref, daemonization, private release file or child process.
