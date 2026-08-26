import { appendFileSync, closeSync, existsSync, openSync, unlinkSync } from 'node:fs';

import { withFileLock } from '../../src/main/services/team/fileLock';

const [mode, target, label, startPath, tracePath, activePath] = process.argv.slice(2);
if ((mode !== 'crash' && mode !== 'barrier') || !target) {
  throw new Error('Invalid file-lock process worker arguments');
}

if (mode === 'crash') {
  await withFileLock(target, async () => {
    process.stdout.write('acquired\n');
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => undefined);
  });
} else {
  if (!label || !startPath || !tracePath || !activePath) {
    throw new Error('Barrier worker requires label, start, trace, and active paths');
  }
  process.stdout.write('ready\n');
  while (!existsSync(startPath)) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await withFileLock(target, async () => {
    const active = openSync(activePath, 'wx');
    closeSync(active);
    appendFileSync(tracePath, `start:${label}\n`, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 15));
    appendFileSync(tracePath, `end:${label}\n`, 'utf8');
    unlinkSync(activePath);
  });
}
