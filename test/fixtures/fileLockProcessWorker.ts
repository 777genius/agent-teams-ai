import { appendFileSync } from 'node:fs';

import {
  getSqliteTransactionLockDatabasePath,
  tryRetainSqliteTransactionLock,
} from '../../src/main/services/infrastructure/SqliteTransactionLock';
import { withFileLock, withFileLockSync } from '../../src/main/services/team/fileLock';

const [mode, target, tracePath] = process.argv.slice(2);
if (
  !target ||
  !tracePath ||
  !['async-holder', 'authority-holder', 'crash-holder', 'sync-contender'].includes(mode ?? '')
) {
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
} else if (mode === 'authority-holder') {
  const authority = tryRetainSqliteTransactionLock(
    getSqliteTransactionLockDatabasePath(target),
    'pre-publication authority lost'
  );
  if (!authority) throw new Error('Could not acquire pre-publication authority');
  appendFileSync(tracePath, 'publication:start\n', 'utf8');
  process.stdout.write('acquired\n');
  await new Promise<void>((resolve) => process.once('message', resolve));
  appendFileSync(tracePath, 'publication:end\n', 'utf8');
  authority.release();
} else if (mode === 'crash-holder') {
  await withFileLock(target, async () => {
    appendFileSync(tracePath, 'crash:start\n', 'utf8');
    process.stdout.write('acquired\n');
    await new Promise<void>((resolve) => process.once('message', resolve));
    process.exit(17);
  });
} else {
  process.stdout.write('attempting\n');
  withFileLockSync(target, () => {
    appendFileSync(tracePath, 'contender:acquired\n', 'utf8');
  });
}
