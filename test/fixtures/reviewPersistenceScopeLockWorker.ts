import { appendFile, readFile, writeFile } from 'fs/promises';

import {
  closeReviewPersistenceScopeLockDatabasesForTests,
  withReviewPersistenceScopeLock,
} from '../../src/main/services/team/ReviewPersistenceScopeLock';
import { setClaudeBasePathOverride } from '../../src/main/utils/pathDecoder';

const [mode, claudeBasePath, logPath, counterPath, workerId, delayValue] =
  process.argv.slice(2);
if (
  (mode !== 'run' && mode !== 'crash') ||
  !claudeBasePath ||
  !logPath ||
  !counterPath ||
  !workerId
) {
  throw new Error('Invalid review persistence lock worker arguments');
}

setClaudeBasePathOverride(claudeBasePath);
const delayMs = Number(delayValue ?? 0);
const persistenceScope = {
  scopeKey: 'task-lock-fixture',
  scopeToken: 'task:lock-fixture:shared-scope',
};

await withReviewPersistenceScopeLock('review-lock-test', persistenceScope, async () => {
  await appendFile(logPath, `${workerId}:enter\n`, 'utf8');
  if (mode === 'crash') {
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => undefined);
    return;
  }
  let current = 0;
  try {
    current = Number(await readFile(counterPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await writeFile(counterPath, String(current + 1), 'utf8');
  await appendFile(logPath, `${workerId}:exit\n`, 'utf8');
});
closeReviewPersistenceScopeLockDatabasesForTests();
