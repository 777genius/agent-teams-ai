/**
 * Standalone racer for the cross-process custom-template name race.
 *
 * Run with: node --import tsx <this file> <databasePath> <templateId> <name>
 *
 * It drives the real InternalStorageWorkerCore on its own connection, so the
 * racing attempt is the production create path rather than a hand-written
 * imitation of the algorithm. It reports readiness on stdout, waits for a
 * single "go" line on stdin, then prints the verbatim create result as JSON.
 */
import { createInterface } from 'node:readline';

import { CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION } from '@features/custom-team-templates/contracts';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import Database from 'better-sqlite3-node';

const [databasePath, templateId, name] = process.argv.slice(2);
if (!databasePath || !templateId || !name) {
  throw new Error('usage: <databasePath> <templateId> <name>');
}

function emit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const core = new InternalStorageWorkerCore({
  databasePath,
  createDatabase: (file) => new Database(file),
  now: () => new Date('2026-10-11T09:00:00.000Z'),
});
core.handle('ping', {});
emit({ type: 'ready' });

const lines = createInterface({ input: process.stdin });
lines.once('line', () => {
  const result = core.handle('customTemplate.create', {
    template: {
      templateId,
      name,
      schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
      teamPrompt: 'Ship the release.',
      members: [{ name: 'alice', role: 'reviewer', workflow: 'review' }],
    },
    contentHash: 'hash-racer',
  });
  emit({ type: 'result', result });
  lines.close();
  core.close();
});
