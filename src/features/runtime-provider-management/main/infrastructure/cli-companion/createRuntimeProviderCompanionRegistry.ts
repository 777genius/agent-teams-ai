import { CursorAgentCompanionService } from '../CursorAgentCompanionService';
import { KiroCliCompanionService } from '../KiroCliCompanionService';

import { CURSOR_AGENT_COMPANION_DEFINITION } from './definitions/CursorAgentCompanionDefinition';
import { KIRO_CLI_COMPANION_DEFINITION } from './definitions/KiroCliCompanionDefinition';

import type { RuntimeProviderCliCompanionServiceDependencies } from './RuntimeProviderCliCompanionService';
import type { RuntimeProviderCompanionRegistry } from './types';

export function createRuntimeProviderCompanionRegistry(
  deps: Pick<RuntimeProviderCliCompanionServiceDependencies, 'emitProgress'> = {}
): RuntimeProviderCompanionRegistry {
  const kiro = new KiroCliCompanionService(deps);
  const cursor = new CursorAgentCompanionService(deps);
  return new Map([
    [
      KIRO_CLI_COMPANION_DEFINITION.companionId,
      { service: kiro, verification: KIRO_CLI_COMPANION_DEFINITION.verification },
    ],
    [
      CURSOR_AGENT_COMPANION_DEFINITION.companionId,
      { service: cursor, verification: CURSOR_AGENT_COMPANION_DEFINITION.verification },
    ],
  ]);
}
