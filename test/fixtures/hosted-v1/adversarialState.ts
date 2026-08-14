import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DEPLOYMENT_ID = 'deployment_hosted-v1-e2e';

async function atomicProviderWrite(path: string, value: unknown): Promise<void> {
  // The host-side provider fixture crosses a bind mount into a non-root controller container.
  // Match provider shared-read semantics instead of creating runner-owned, unreadable 0600 files.
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const staged = `${path}.provider-${process.pid}-${Date.now()}`;
  await writeFile(staged, `${JSON.stringify(value)}\n`, { mode: 0o644 });
  await rename(staged, path);
}

export async function writeProviderTask(input: {
  claudeDir: string;
  teamName: string;
  taskId: string;
  subject: string;
}): Promise<void> {
  await atomicProviderWrite(
    join(input.claudeDir, 'tasks', input.teamName, `${input.taskId}.json`),
    {
      id: input.taskId,
      subject: input.subject,
      description: 'Provider-side sandbox fixture write',
      status: 'pending',
      blockedBy: [],
      blocks: [],
      related: [],
    }
  );
}

export async function writeProviderInbox(input: {
  claudeDir: string;
  teamName: string;
  recipient: string;
  message: string;
}): Promise<void> {
  const path = join(input.claudeDir, 'teams', input.teamName, 'inboxes', `${input.recipient}.json`);
  const current = JSON.parse(await readFile(path, 'utf8').catch(() => '[]')) as unknown[];
  current.push({
    from: 'provider-external-writer',
    text: input.message,
    timestamp: new Date().toISOString(),
  });
  await atomicProviderWrite(path, current);
}

/**
 * Observes the live production retention owner through a read-only SQLite connection. The fixture
 * never creates a second storage worker or requests pruning; the controller's scheduler and its
 * existing serialized worker remain the only mutation path.
 */
export async function waitForProductionCoordinationRetention(appDataDir: string): Promise<{
  readonly highWatermarkSequence: number;
  readonly retentionFloorSequence: number;
}> {
  const { default: Database } = await import('better-sqlite3-node');
  const database = new Database(join(appDataDir, 'data', 'storage', 'app.db'), {
    fileMustExist: true,
    readonly: true,
  });
  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const row = database
        .prepare(
          `SELECT high_watermark_sequence AS highWatermarkSequence,
                  retention_floor_sequence AS retentionFloorSequence
             FROM coordination_event_journal_metadata
            WHERE deployment_id = ?`
        )
        .get(DEPLOYMENT_ID) as
        | { readonly highWatermarkSequence: number; readonly retentionFloorSequence: number }
        | undefined;
      if (
        row !== undefined &&
        row.highWatermarkSequence >= 3 &&
        row.retentionFloorSequence === row.highWatermarkSequence - 1
      ) {
        return Object.freeze(row);
      }
      if (Date.now() >= deadline) {
        throw new Error('hosted_e2e_production_retention_timeout');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    database.close();
  }
}
