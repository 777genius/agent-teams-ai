import { TaskChangeLedgerReader as PortableTaskChangeLedgerReader } from '@agent-teams/task-change-ledger';
import { createLogger } from '@shared/utils/logger';

export { TASK_CHANGE_LEDGER_READ_LIMITS } from '@agent-teams/task-change-ledger';

const logger = createLogger('Service:TaskChangeLedgerReader');

/** Desktop logging adapter; the portable reader owns every ledger algorithm. */
export class TaskChangeLedgerReader {
  private readonly reader = new PortableTaskChangeLedgerReader({
    debug: (message) => logger.debug(message),
  });

  readTaskChanges(
    ...args: Parameters<PortableTaskChangeLedgerReader['readTaskChanges']>
  ): ReturnType<PortableTaskChangeLedgerReader['readTaskChanges']> {
    return this.reader.readTaskChanges(...args);
  }
}
