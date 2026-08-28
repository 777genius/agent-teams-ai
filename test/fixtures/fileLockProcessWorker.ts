import { appendFileSync, readSync } from 'node:fs';

import { resolveDesktopSqliteLockAuthority } from '../../src/main/services/infrastructure/DesktopSqliteLockAuthority';
import {
  setSqliteTransactionLockTestHooksForTests,
  tryRetainSqliteTransactionLock,
} from '../../src/main/services/infrastructure/SqliteTransactionLock';
import { withFileLock, withFileLockSync } from '../../src/main/services/team/fileLock';

const [mode, target, tracePath] = process.argv.slice(2);
if (
  !target ||
  !tracePath ||
  ![
    'async-holder',
    'authority-holder',
    'crash-holder',
    'sqlite-before-provenance-holder',
    'sqlite-crash-holder',
    'sqlite-durable-release-holder',
    'sqlite-partial-release-holder',
    'sqlite-partial-provenance-holder',
    'sync-contender',
  ].includes(mode ?? '')
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
    resolveDesktopSqliteLockAuthority(target).databasePath,
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
} else if (
  mode === 'sqlite-before-provenance-holder' ||
  mode === 'sqlite-partial-provenance-holder'
) {
  const pausePublication = () => {
    process.stdout.write('acquired\n');
    readSync(0, Buffer.alloc(1), 0, 1, null);
  };
  setSqliteTransactionLockTestHooksForTests(
    mode === 'sqlite-before-provenance-holder'
      ? { beforeProvenancePublication: pausePublication }
      : { afterPartialProvenanceWrite: pausePublication }
  );
  const authority = tryRetainSqliteTransactionLock(target, 'paused publication holder lost');
  if (!authority) throw new Error('Could not retain paused publication authority');
  process.stdout.write('published\n');
  await new Promise<void>((resolve) => process.once('message', resolve));
  authority.release();
  process.stdout.write('released\n');
} else if (mode === 'sqlite-crash-holder') {
  setSqliteTransactionLockTestHooksForTests({
    afterDatabaseOpen: (_databasePath, database) => {
      database.prepare("UPDATE recovery_state SET value = 'uncommitted'").run();
    },
  });
  const authority = tryRetainSqliteTransactionLock(target, 'crash holder lost ownership');
  if (!authority) throw new Error('Could not acquire SQLite crash authority');
  process.stdout.write('acquired\n');
  await new Promise<void>(() => undefined);
} else if (mode === 'sqlite-durable-release-holder' || mode === 'sqlite-partial-release-holder') {
  setSqliteTransactionLockTestHooksForTests({
    afterDatabaseOpen: (_databasePath, database) => {
      database.prepare("UPDATE recovery_state SET value = 'uncommitted'").run();
    },
    ...(mode === 'sqlite-durable-release-holder'
      ? {
          afterDurableReleasePublication: () => {
            process.stdout.write('release-state\n');
            readSync(0, Buffer.alloc(1), 0, 1, null);
          },
        }
      : {
          afterPartialReleaseWrite: () => {
            process.stdout.write('partial-release\n');
            readSync(0, Buffer.alloc(1), 0, 1, null);
          },
        }),
  });
  const authority = tryRetainSqliteTransactionLock(target, 'release holder lost ownership');
  if (!authority) throw new Error('Could not acquire SQLite release authority');
  process.stdout.write('acquired\n');
  authority.release();
} else {
  process.stdout.write('attempting\n');
  withFileLockSync(target, () => {
    appendFileSync(tracePath, 'contender:acquired\n', 'utf8');
  });
}
