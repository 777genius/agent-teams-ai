import { KIRO_CLI_COMPANION_DEFINITION } from './cli-companion/definitions/KiroCliCompanionDefinition';
import { RuntimeProviderCliCompanionService } from './cli-companion/RuntimeProviderCliCompanionService';

import type { RuntimeProviderCliCompanionServiceDependencies } from './cli-companion/RuntimeProviderCliCompanionService';

export { resolveKiroLinuxArchiveSuffix } from './cli-companion/definitions/KiroCliCompanionDefinition';

export type KiroCliCompanionServiceDependencies = RuntimeProviderCliCompanionServiceDependencies;

/** Backward-compatible Kiro facade over the provider-agnostic companion engine. */
export class KiroCliCompanionService extends RuntimeProviderCliCompanionService {
  constructor(deps: KiroCliCompanionServiceDependencies = {}) {
    super(KIRO_CLI_COMPANION_DEFINITION, deps);
  }
}
