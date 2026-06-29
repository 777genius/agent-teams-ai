import {
  ClaudePtyWorkspaceTrustStrategy,
  DefaultWorkspaceTrustCoordinator,
} from '../../core/application';
import { FileClaudeStateProbe } from '../adapters/output/ClaudeStateProbe';
import { FileClaudeTrustPersister } from '../adapters/output/ClaudeTrustPersister';
import { NodePtyProcessAdapter } from '../adapters/output/NodePtyProcessAdapter';
import { FileTempEmptyMcpConfigStore } from '../adapters/output/TempEmptyMcpConfigStore';

import type { WorkspaceTrustCoordinator } from '../../core/application';

export function createWorkspaceTrustCoordinator(input: {
  claudeConfigDir?: string | (() => string);
  globalConfigFilePath: string | (() => string);
}): WorkspaceTrustCoordinator {
  return new DefaultWorkspaceTrustCoordinator(
    new ClaudePtyWorkspaceTrustStrategy({
      ptyProcess: new NodePtyProcessAdapter(),
      stateProbe: new FileClaudeStateProbe({
        claudeConfigDir:
          typeof input.claudeConfigDir === 'function'
            ? input.claudeConfigDir()
            : input.claudeConfigDir,
        globalConfigFilePath: input.globalConfigFilePath,
      }),
      trustPersister: new FileClaudeTrustPersister({
        claudeConfigDir:
          typeof input.claudeConfigDir === 'function'
            ? input.claudeConfigDir()
            : input.claudeConfigDir,
        globalConfigFilePath: input.globalConfigFilePath,
      }),
      tempEmptyMcpConfigStore: new FileTempEmptyMcpConfigStore(),
    })
  );
}
