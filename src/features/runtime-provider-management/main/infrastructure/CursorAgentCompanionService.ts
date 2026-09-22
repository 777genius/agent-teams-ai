import { CURSOR_AGENT_COMPANION_DEFINITION } from './cli-companion/definitions/CursorAgentCompanionDefinition';
import { RuntimeProviderCliCompanionService } from './cli-companion/RuntimeProviderCliCompanionService';

import type { RuntimeProviderCliCompanionServiceDependencies } from './cli-companion/RuntimeProviderCliCompanionService';

export type CursorAgentCompanionServiceDependencies =
  RuntimeProviderCliCompanionServiceDependencies;

export class CursorAgentCompanionService extends RuntimeProviderCliCompanionService {
  constructor(deps: CursorAgentCompanionServiceDependencies = {}) {
    super(CURSOR_AGENT_COMPANION_DEFINITION, deps);
  }
}
