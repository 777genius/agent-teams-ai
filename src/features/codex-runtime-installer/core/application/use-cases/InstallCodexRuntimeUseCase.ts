import type { CodexRuntimeInstallerPort } from '../ports/CodexRuntimeInstallerPort';
import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';

export class InstallCodexRuntimeUseCase {
  constructor(private readonly installer: Pick<CodexRuntimeInstallerPort, 'install'>) {}

  execute(): Promise<CodexRuntimeStatus> {
    return this.installer.install();
  }
}
