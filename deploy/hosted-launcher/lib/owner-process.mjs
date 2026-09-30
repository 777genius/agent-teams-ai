import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { observeOwnerSocket } from './admission.mjs';
import { raceTimeout, sleep } from './process.mjs';

const HELPER = fileURLToPath(new URL('../owner-spawn.py', import.meta.url));

function jsonLines(stream, onValue, onError) {
  let pending = '';
  stream.on('data', bytes => {
    pending += bytes.toString('utf8');
    if (pending.length > 16_384) { onError(new Error('hostedctl-owner-helper-output-too-large')); return; }
    for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try { onValue(JSON.parse(line)); } catch (error) { onError(error); return; }
    }
  });
}

/**
 * Starts the root helper, which starts Owner. The returned handle keeps the helper's stdin open:
 * that pipe is the liveness lease. `exited` resolves when Owner is gone for any reason.
 */
export async function spawnOwner(spec, { python = '/usr/bin/python3', spawnTimeoutMs = 30_000 } = {}) {
  const child = spawn(python, ['-I', HELPER], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' } });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-2000); });
  let spawned;
  let failed;
  const ready = new Promise((resolveReady, rejectReady) => { spawned = resolveReady; failed = rejectReady; });
  let ownerExitCode;
  const exited = new Promise(resolveExit => {
    child.once('exit', code => {
      failed(new Error(`hostedctl-owner-helper-exit:${code}:${stderr.slice(-400)}`));
      resolveExit({ helperCode: code, ownerCode: ownerExitCode });
    });
  });
  child.once('error', error => failed(error));
  const timer = setTimeout(() => failed(new Error('hostedctl-owner-helper-timeout')), spawnTimeoutMs);
  jsonLines(child.stdout, value => {
    if (value?.kind === 'spawned' && Number.isSafeInteger(value.pid) && value.pid > 0 &&
        value.attestation?.environmentVerified === true) {
      clearTimeout(timer);
      spawned(value);
    } else if (value?.kind === 'launcher-error') {
      clearTimeout(timer);
      failed(new Error(`hostedctl-owner-helper:${value.reason}`));
    } else if (value?.kind === 'owner-exit') {
      ownerExitCode = value.code;
    }
  }, failed);
  child.stdin.on('error', () => undefined);
  child.stdin.write(`${JSON.stringify(spec)}\n`);
  let closed = false;
  const close = async (timeoutMs = 60_000) => {
    if (!closed) { closed = true; child.stdin.end(); }
    if (child.exitCode !== null || child.signalCode !== null) return exited;
    const done = await Promise.race([exited, raceTimeout(timeoutMs).then(() => null)]);
    if (done) return done;
    child.kill('SIGKILL');
    return exited;
  };
  try {
    const value = await ready;
    return Object.freeze({ pid: value.pid, helperPid: child.pid, attestation: value.attestation,
      exited, close });
  } catch (error) {
    clearTimeout(timer);
    await close(10_000);
    throw error;
  }
}

export async function waitForOwnerSocket(path, { uid, gid, owner, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  owner.exited.then(() => { exited = true; });
  while (Date.now() < deadline) {
    if (exited) throw new Error('hostedctl-owner-exited-before-socket');
    try { return await observeOwnerSocket(path, uid, gid); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await sleep(200);
  }
  throw new Error('hostedctl-owner-socket-timeout');
}

export async function waitForPathRemoval(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const present = await lstat(path).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error));
    if (!present) return true;
    await sleep(200);
  }
  return false;
}
