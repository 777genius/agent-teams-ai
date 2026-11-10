import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [role, root, actor, name, mode] = process.argv.slice(2);
assert.ok(root && actor && name && mode);
assert.ok(root.startsWith('/private/tmp/TEST-') && /^[a-z]+$/.test(name));
assert.ok(mode === 'same' || mode === 'cross');
assert.ok(role === 'root' || role === 'bridge');
const child = role === 'root' && mode === 'cross'
  ? spawn(process.execPath, [import.meta.filename, 'bridge', root, actor, name, mode], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  : spawn(actor, [root, name], { detached: false, stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout!.pipe(process.stdout);
if (role === 'root' && mode === 'cross') child.once('exit', () => writeFileSync(join(root, name + '.bridge-gone'), '{}', { mode: 0o600, flag: 'wx' }));
const timer = setInterval(() => {
  if (existsSync(join(root, name + '.' + role + '-exit'))) process.exit(0);
}, 20);
setTimeout(() => { clearInterval(timer); process.exit(0); }, 10_000);
// Only private self-exit controls and finite lifetimes; no numeric/group signal or detached adoption.
