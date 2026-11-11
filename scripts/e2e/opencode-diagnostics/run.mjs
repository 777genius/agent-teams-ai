// Optional noninteractive recipe. Requires preinstalled desktop dependencies and a display.
import { spawn, spawnSync } from 'node:child_process';
import { open, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { catalogScenarios } from './catalog.mjs';
const harness = fileURLToPath(new URL('../opencode-diagnostics-desktop.mjs', import.meta.url));
const resourceSampler = fileURLToPath(new URL('./startup-resources.mjs', import.meta.url));
const command = (mode, root) =>
  spawnSync(process.execPath, [harness, mode, ...(root ? [root] : [])], { encoding: 'utf8' });
const scenarioOption = process.argv.slice(2).join(' ');
const startupCleanup = scenarioOption === '--startup-cleanup';
const realRuntime = scenarioOption === '--real-runtime';
if (process.argv.length > 2 && !startupCleanup && !realRuntime)
  throw new Error('Unsupported runner arguments');
const seed = command(realRuntime ? 'seed-real' : 'seed',
  startupCleanup ? 'startup-cleanup' : undefined);
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
    if (inspection.status === 0 &&
      (!realRuntime || inspection.stdout.includes('E2E_DASHBOARD_MOUNTED=true'))) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (inspection?.status !== 0 || (realRuntime && !inspection.stdout.includes('E2E_DASHBOARD_MOUNTED=true')))
    throw new Error('Mounted Dashboard unavailable within the owned renderer readiness budget');
  await writeFile(path.join(root, 'inspect.txt'), inspection.stdout);
  const measure = (phase) => {
    const result = spawnSync(process.execPath, [resourceSampler, root, phase], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Owned startup resource sample failed: ' + phase);
    process.stdout.write(result.stdout);
  };
  if (realRuntime) {
    measure('renderer-ready');
    await new Promise((resolve) => setTimeout(resolve, 5000));
    measure('post-renderer-delay');
  }
  for (const scenario of realRuntime
    ? ['real-connected']
    : startupCleanup
      ? ['startup-cleanup']
      : ['version-exit', 'version-timeout', 'ready', ...catalogScenarios]) {
    await writeFile(path.join(root, 'scenario'), scenario);
    const result = command('verify', root);
    await writeFile(path.join(root, `verify-${scenario}.txt`), result.stdout + result.stderr);
    if (result.status !== 0)
      throw new Error(`Verification failed: ${scenario}; see sandbox artifacts`);
    process.stdout.write(result.stdout);
  }
  if (realRuntime) measure('after-provider-settings');
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  const result = command('stop', root);
  try {
    await log.close();
  } catch (error) {
    if (primaryError) console.error(`Log cleanup failed: ${error.message}`);
    else throw error;
  }
  if (result.status !== 0) {
    launcher.unref();
    const cleanupError = new Error(
      `Owned cleanup refused; no broad kill attempted: ${result.stderr}`
    );
    if (primaryError) console.error(cleanupError.message);
    else throw cleanupError;
  }
}
