import { GetCodexRuntimeStatusUseCase } from '../../core/application/use-cases/GetCodexRuntimeStatusUseCase';
import { InstallCodexRuntimeUseCase } from '../../core/application/use-cases/InstallCodexRuntimeUseCase';
import {
  CodexRuntimeInstallerService,
  type CodexRuntimeInstallerServiceDependencies,
} from '../infrastructure/CodexRuntimeInstallerService';

import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type { BrowserWindow } from 'electron';

export interface CodexRuntimeInstallerFeatureFacade {
  getStatus: () => Promise<CodexRuntimeStatus>;
  install: () => Promise<CodexRuntimeStatus>;
  invalidateStatus: () => void;
  setMainWindow: (window: BrowserWindow | null) => void;
}

export function createCodexRuntimeInstallerFeature(
  dependencies: CodexRuntimeInstallerServiceDependencies = {}
): CodexRuntimeInstallerFeatureFacade {
  const service = new CodexRuntimeInstallerService(dependencies);
  const getStatusUseCase = new GetCodexRuntimeStatusUseCase(service);
  const installUseCase = new InstallCodexRuntimeUseCase(service);

  return {
    getStatus: () => getStatusUseCase.execute(),
    install: () => installUseCase.execute(),
    invalidateStatus: () => {
      service.invalidateStatusCache();
    },
    setMainWindow: (window) => {
      service.setMainWindow(window);
    },
  };
}
