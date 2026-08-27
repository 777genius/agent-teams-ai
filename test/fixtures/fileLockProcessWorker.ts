import { appendFileSync } from 'node:fs';

import { withFileLock, withFileLockSync } from '../../src/main/services/team/fileLock';

const [mode, target, tracePath] = process.argv.slice(2);
if (!target || !tracePath || (mode !== 'async-holder' && mode !== 'sync-contender')) {
  throw new Error('Invalid file-lock process worker arguments');
}

if (mode === 'async-holder') {
  await withFileLock(target, async () => {
    appendFileSync(tracePath, 'holder:start\n', 'utf8');
    process.stdout.write('acquired\n');
    await new Promise<void>((resolve) => {
      process.once('message', resolve);
    });
    appendFileSync(tracePath, 'holder:end\n', 'utf8');
  });
} else {
  process.stdout.write('attempting\n');
  withFileLockSync(target, () => {
    appendFileSync(tracePath, 'contender:acquired\n', 'utf8');
  });
}
