import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { TeamTaskAttachmentStore } from '../../../../../src/main/services/team/TeamTaskAttachmentStore';
import {
  atomicCreateAsync,
  cleanupAtomicCreateTempLinks,
} from '../../../../../src/main/utils/atomicWrite';
import { setAppDataBasePath } from '../../../../../src/main/utils/pathDecoder';

const root = process.env.TASK_ATTACHMENT_STORE_RACE_ROOT;
const participant = process.env.TASK_ATTACHMENT_STORE_RACE_PARTICIPANT;
if (!root || !participant) {
  throw new Error('Missing task attachment race worker environment');
}

setAppDataBasePath(root);
const barrierDirectory = join(root, 'race-barrier');
const readyPath = join(barrierDirectory, `${participant}.ready`);

const store = new TeamTaskAttachmentStore({
  async createFileAtomically(filePath, data) {
    await fs.mkdir(barrierDirectory, { recursive: true });
    await fs.writeFile(readyPath, '');

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const readyParticipants = (await fs.readdir(barrierDirectory)).filter((entry) =>
        entry.endsWith('.ready')
      );
      if (readyParticipants.length >= 2) {
        return atomicCreateAsync(filePath, data);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for the cross-process attachment race barrier');
  },
  cleanupPublishedTempLinks: cleanupAtomicCreateTempLinks,
});

try {
  const metadata = await store.saveAttachment(
    'my-team',
    'task-1',
    '11111111-1111-4111-8111-111111111111',
    `${participant}.png`,
    'image/png',
    Buffer.from(participant).toString('base64')
  );
  process.stdout.write(
    `TASK_ATTACHMENT_RACE_RESULT:${JSON.stringify({ filePath: metadata.filePath })}\n`
  );
} catch (error) {
  process.stdout.write(
    `TASK_ATTACHMENT_RACE_RESULT:${JSON.stringify({
      errorCode: (error as NodeJS.ErrnoException).code,
      errorMessage: error instanceof Error ? error.message : String(error),
    })}\n`
  );
}
