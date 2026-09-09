// Native Node child used by both protocol suites. No runtime/provider state.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');

const [modulePath, resource, controlDir, implementation, phase] = process.argv.slice(2);
const lock = `${resource}.lock`;
const gate = `${lock}-transition-v2`;
const original = Object.fromEntries(
  [
    'mkdirSync',
    'openSync',
    'writeSync',
    'closeSync',
    'renameSync',
    'linkSync',
    'unlinkSync',
    'rmdirSync',
  ].map((key) => [key, fs[key].bind(fs)])
);
const fds = new Map();
let stopped = false;
function barrier(point) {
  if (stopped || point !== phase) return;
  stopped = true;
  fs.writeFileSync(
    path.join(controlDir, 'paused.json'),
    JSON.stringify({ point, pid: process.pid })
  );
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(path.join(controlDir, 'resume'))) {
    if (Date.now() > deadline) throw new Error(`Barrier expired: ${point}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
function kind(name) {
  if (String(name).startsWith(`${gate}.candidate-`)) return 'gate-candidate';
  if (String(name).startsWith(`${lock}.candidate-`)) return 'data-candidate';
  return '';
}
fs.mkdirSync = (name, ...args) => {
  const result = original.mkdirSync(name, ...args);
  if (kind(name) === 'gate-candidate') barrier('gate-candidate-created');
  return result;
};
fs.openSync = (name, ...args) => {
  const fd = original.openSync(name, ...args);
  fds.set(fd, kind(name));
  if (kind(name)) barrier(`${kind(name)}-opened`);
  return fd;
};
fs.writeSync = (fd, bytes, offset, length, ...args) => {
  // Force an actual partial write before interruption of each candidate write.
  const size = fds.has(fd) && Buffer.isBuffer(bytes) ? Math.min(length, 3) : length;
  const written = original.writeSync(fd, bytes, offset, size, ...args);
  if (fds.get(fd)) barrier(`${fds.get(fd)}-partial`);
  return written;
};
fs.closeSync = (fd) => {
  const type = fds.get(fd);
  const result = original.closeSync(fd);
  fds.delete(fd);
  if (type) barrier(`${type}-closed`);
  return result;
};
fs.renameSync = (from, to) => {
  if (to === gate) barrier('gate-publish-before');
  const result = original.renameSync(from, to);
  if (to === gate) barrier('gate-publish-after');
  return result;
};
fs.linkSync = (from, to) => {
  if (to === lock) barrier('data-publish-before');
  const result = original.linkSync(from, to);
  if (to === lock) barrier('data-publish-after');
  return result;
};
fs.unlinkSync = (name) => {
  const point =
    name === lock ? 'data-unlink' : path.dirname(String(name)) === gate ? 'gate-token-unlink' : '';
  if (point) barrier(`${point}-before`);
  const result = original.unlinkSync(name);
  if (point) barrier(`${point}-after`);
  return result;
};
fs.rmdirSync = (name) => {
  if (name === gate) barrier('gate-rmdir-before');
  const result = original.rmdirSync(name);
  if (name === gate) barrier('gate-rmdir-after');
  return result;
};
syncBuiltinESMExports();
(async () => {
  const mod =
    implementation === 'controller'
      ? require(modulePath)
      : await import(pathToFileURL(modulePath).href);
  const callback = () => {
    fs.writeFileSync(path.join(controlDir, 'entered'), 'yes');
    barrier('callback');
    return 'ok';
  };
  const options = { acquireTimeoutMs: 800, retryIntervalMs: 2, staleTimeoutMs: 1 };
  if (implementation === 'async') await mod.withFileLock(resource, async () => callback(), options);
  else mod.withFileLockSync(resource, callback, options);
})().catch((error) => {
  fs.writeFileSync(
    path.join(controlDir, 'error.json'),
    JSON.stringify({ message: error.message, code: error.code })
  );
  process.exitCode = 1;
});
