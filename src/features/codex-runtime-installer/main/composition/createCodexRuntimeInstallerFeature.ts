import { GetCodexRuntimeStatusUseCase } from '../../core/application/use-cases/GetCodexRuntimeStatusUseCase';
import { InstallCodexRuntimeUseCase } from '../../core/application/use-cases/InstallCodexRuntimeUseCase';
import { CapturedCodexRuntimeInstaller } from '../application/CapturedCodexRuntimeInstaller';
import {
  CodexRuntimeInstallerService,
  type CodexRuntimeInstallerServiceDependencies,
} from '../infrastructure/CodexRuntimeInstallerService';

import type { CapturedCodexInstallRequest } from '../application/CapturedCodexRuntimeInstaller';
import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type { BrowserWindow } from 'electron';

export interface CodexRuntimeInstallerFeatureFacade {
  getStatus: (captured?: CapturedCodexInstallRequest) => Promise<CodexRuntimeStatus>;
  install: (captured?: CapturedCodexInstallRequest) => Promise<CodexRuntimeStatus>;
  invalidateStatus: (captured?: CapturedCodexInstallRequest) => void | Promise<void>;
  setMainWindow: (window: BrowserWindow | null) => void;
}

async function capturedResult<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    throw new Error('The original Codex runtime selection could not be confirmed.', { cause });
  }
}

export function createCodexRuntimeInstallerFeature(
  dependencies: CodexRuntimeInstallerServiceDependencies = {}
): CodexRuntimeInstallerFeatureFacade {
  const service = new CodexRuntimeInstallerService(dependencies);
  const getStatusUseCase = new GetCodexRuntimeStatusUseCase(service);
  const installUseCase = new InstallCodexRuntimeUseCase(service);
  const capturedInstaller = new CapturedCodexRuntimeInstaller(service);

  return {
    getStatus: (captured) =>
      captured
        ? capturedResult(() => capturedInstaller.getStatus(captured))
        : getStatusUseCase.execute(),
    install: (captured) =>
      captured
        ? capturedResult(() => capturedInstaller.install(captured))
        : installUseCase.execute(),
    invalidateStatus: (captured) => {
      if (captured)
        return capturedResult(() => capturedInstaller.selectInstalled(captured)).then(
          () => undefined
        );
      service.invalidateStatusCache();
    },
    setMainWindow: (window) => {
      service.setMainWindow(window);
    },
  };
}
