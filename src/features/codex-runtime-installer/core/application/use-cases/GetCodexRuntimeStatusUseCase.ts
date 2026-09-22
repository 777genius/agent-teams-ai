import type { CodexRuntimeInstallerPort } from '../ports/CodexRuntimeInstallerPort';
import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';

export class GetCodexRuntimeStatusUseCase {
  constructor(private readonly installer: Pick<CodexRuntimeInstallerPort, 'getStatus'>) {}

  execute(): Promise<CodexRuntimeStatus> {
    return this.installer.getStatus();
  }
}
