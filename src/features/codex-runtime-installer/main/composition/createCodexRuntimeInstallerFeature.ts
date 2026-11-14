import { GetCodexRuntimeStatusUseCase } from '../../core/application/use-cases/GetCodexRuntimeStatusUseCase';
import { InstallCodexRuntimeUseCase } from '../../core/application/use-cases/InstallCodexRuntimeUseCase';
import { CapturedCodexRuntimeInstaller } from '../application/CapturedCodexRuntimeInstaller';
import { captureCodexNativeSelection } from '../infrastructure/captureCodexNativeSelection';
import {
  CodexRuntimeInstallerService,
  type CodexRuntimeInstallerServiceDependencies,
} from '../infrastructure/CodexRuntimeInstallerService';

import type { CapturedRuntimeSources } from '@features/agent-backend/main';
import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type { BrowserWindow } from 'electron';

export interface CodexRuntimeInstallerFeatureFacade {
  getStatus: () => Promise<CodexRuntimeStatus>;
  install: (sources?: CapturedRuntimeSources) => Promise<CodexRuntimeStatus>;
  invalidateStatus: (sources?: CapturedRuntimeSources) => void | Promise<void>;
  setMainWindow: (window: BrowserWindow | null) => void;
}

export function createCodexRuntimeInstallerFeature(
  dependencies: CodexRuntimeInstallerServiceDependencies = {}
): CodexRuntimeInstallerFeatureFacade {
  const service = new CodexRuntimeInstallerService(dependencies);
  const getStatusUseCase = new GetCodexRuntimeStatusUseCase(service);
  const installUseCase = new InstallCodexRuntimeUseCase(service);
  const captured = new CapturedCodexRuntimeInstaller({
    native: service,
    captureSelection: captureCodexNativeSelection,
  });

  return {
    getStatus: () => getStatusUseCase.execute(),
    install: (sources) => (sources ? captured.install(sources) : installUseCase.execute()),
    invalidateStatus: async (sources) => {
      service.invalidateStatusCache();
      if (sources) {
        const status = await captured.selectInstalled(sources);
        if (status.state !== 'ready')
          throw new Error(status.error ?? 'Codex selection could not be confirmed.');
      }
    },
    setMainWindow: (window) => {
      service.setMainWindow(window);
    },
  };
}
