import type { CustomTeamTemplateStorageGateway } from './ports';
import type { ListCustomTeamTemplatesResult } from '@features/custom-team-templates/contracts';

export interface ListCustomTeamTemplatesUseCaseDeps {
  /** Null when the SQLite worker bundle is unavailable in this environment. */
  gateway: CustomTeamTemplateStorageGateway | null;
}

/**
 * Reads the saved template library.
 *
 * Read-only by design: A1 exposes no update or delete operation, so this use
 * case cannot mutate the library even by accident.
 *
 * An empty library and an unavailable or failing store are kept strictly
 * apart. A store failure is never reported as an empty library, because that
 * would tell the user their templates are gone when they are merely unreadable,
 * and records that cannot be reconstructed are surfaced with their ids instead
 * of being dropped or reinterpreted as valid empty templates.
 */
export class ListCustomTeamTemplatesUseCase {
  constructor(private readonly deps: ListCustomTeamTemplatesUseCaseDeps) {}

  async execute(): Promise<ListCustomTeamTemplatesResult> {
    const gateway = this.deps.gateway;
    if (!gateway) {
      return { status: 'storageUnavailable' };
    }

    let listed;
    try {
      listed = await gateway.customTeamTemplateList();
    } catch {
      return { status: 'storageUnavailable' };
    }

    if (listed.unreadableRecords.length > 0) {
      return {
        status: 'hasUnreadableRecords',
        templates: listed.templates,
        unreadableRecords: listed.unreadableRecords,
      };
    }
    if (listed.templates.length === 0) {
      return { status: 'empty' };
    }
    return { status: 'ready', templates: listed.templates };
  }
}
