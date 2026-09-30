import { spawn } from 'node:child_process';

/**
 * Runs one command without a shell. Output is bounded; errors carry only a short stderr tail so
 * that bootstrap material or provider output never floods the journal.
 */
export function run(command, args, { env = process.env, cwd, timeoutMs = 120_000, uid, gid,
  inherit = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env, cwd, uid, gid,
      stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let size = 0;
    const collect = parts => bytes => {
      size += bytes.length;
      if (size > 8 * 1024 * 1024) child.kill('SIGKILL');
      else parts.push(bytes);
    };
    child.stdout?.on('data', collect(out));
    child.stderr?.on('data', collect(err));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8').trim();
      if (code === 0) { resolveRun(stdout); return; }
      const tail = Buffer.concat(err).toString('utf8').slice(-600);
      const error = new Error(`hostedctl-command-failed:${command} ${args[0] ?? ''}:${code}:${tail}`);
      error.exitCode = code;
      reject(error);
    });
  });
}

export const docker = (args, options) => run('docker', args, options);
export const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

/** A timeout for Promise.race that does not keep the process alive after the race is decided. */
export const raceTimeout = ms => new Promise(resolveTimeout => setTimeout(resolveTimeout, ms).unref());
