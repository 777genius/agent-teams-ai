// Optional noninteractive recipe. Requires preinstalled desktop dependencies and a display.
import { spawn, spawnSync } from 'node:child_process';
import { open, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const harness = fileURLToPath(new URL('../opencode-diagnostics-desktop.mjs', import.meta.url));
const command = (mode, root) =>
  spawnSync(process.execPath, [harness, mode, ...(root ? [root] : [])], { encoding: 'utf8' });
const seed = command('seed');
if (seed.status !== 0) throw new Error(seed.stderr);
const root = seed.stdout.trim();
console.log(`Sandbox artifacts: ${root}`);
const log = await open(path.join(root, 'desktop.log'), 'a');
const launcher = spawn(process.execPath, [harness, 'start', root], {
  stdio: ['ignore', log.fd, log.fd],
});
let exited = false;
let primaryError;
launcher.once('exit', () => {
  exited = true;
});
launcher.once('error', () => {
  exited = true;
});
try {
  let inspection;
  for (let i = 0; i < 120; i++) {
    if (exited) throw new Error('Desktop launcher exited; inspect desktop.log');
    inspection = command('inspect', root); // Ownership checked before every CDP request.
    if (inspection.status === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (inspection?.status !== 0) throw new Error(inspection?.stderr || 'Renderer unavailable');
  await writeFile(path.join(root, 'inspect.txt'), inspection.stdout);
  for (const scenario of ['version-exit', 'version-timeout', 'ready']) {
    await writeFile(path.join(root, 'scenario'), scenario);
    const result = command('verify', root);
    await writeFile(path.join(root, `verify-${scenario}.txt`), result.stdout + result.stderr);
    if (result.status !== 0)
      throw new Error(`Verification failed: ${scenario}; see sandbox artifacts`);
    process.stdout.write(result.stdout);
  }
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  const result = command('stop', root);
  await log.close();
  if (result.status !== 0) {
    launcher.unref();
    const cleanupError = new Error(
      `Owned cleanup refused; no broad kill attempted: ${result.stderr}`
    );
    if (primaryError) console.error(cleanupError.message);
    else throw cleanupError;
  }
}
