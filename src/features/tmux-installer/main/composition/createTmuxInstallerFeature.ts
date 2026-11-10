import { CancelTmuxInstallUseCase } from '@features/tmux-installer/core/application/use-cases/CancelTmuxInstallUseCase';
import { GetTmuxInstallerSnapshotUseCase } from '@features/tmux-installer/core/application/use-cases/GetTmuxInstallerSnapshotUseCase';
import { GetTmuxStatusUseCase } from '@features/tmux-installer/core/application/use-cases/GetTmuxStatusUseCase';
import { InstallTmuxUseCase } from '@features/tmux-installer/core/application/use-cases/InstallTmuxUseCase';
import { SubmitTmuxInstallerInputUseCase } from '@features/tmux-installer/core/application/use-cases/SubmitTmuxInstallerInputUseCase';

import { TmuxInstallerProgressPresenter } from '../adapters/output/presenters/TmuxInstallerProgressPresenter';
import { TmuxInstallerRunnerAdapter } from '../adapters/output/runtime/TmuxInstallerRunnerAdapter';
import { TmuxStatusSourceAdapter } from '../adapters/output/sources/TmuxStatusSourceAdapter';

import { invalidateTmuxRuntimeStatusCache } from './runtimeSupport';

import type { TmuxInstallerSnapshot, TmuxStatus } from '@features/tmux-installer/contracts';
import type { BrowserWindow } from 'electron';

export interface TmuxInstallerFeatureFacade {
  getStatus(): Promise<TmuxStatus>;
  getInstallerSnapshot(): TmuxInstallerSnapshot;
  install(): Promise<void>;
  cancelInstall(): Promise<void>;
  submitInstallerInput(input: string): Promise<void>;
  invalidateStatus(): void;
  setMainWindow(window: BrowserWindow | null): void;
}

class TmuxInstallerFeatureFacadeImpl implements TmuxInstallerFeatureFacade {
  readonly #presenter: TmuxInstallerProgressPresenter;
  readonly #statusSource: TmuxStatusSourceAdapter;
  readonly #runner: TmuxInstallerRunnerAdapter;
  readonly #getStatusUseCase: GetTmuxStatusUseCase;
  readonly #getSnapshotUseCase: GetTmuxInstallerSnapshotUseCase;
  readonly #installUseCase: InstallTmuxUseCase;
  readonly #cancelUseCase: CancelTmuxInstallUseCase;
  readonly #submitInputUseCase: SubmitTmuxInstallerInputUseCase;

  constructor() {
    this.#presenter = new TmuxInstallerProgressPresenter();
    this.#statusSource = new TmuxStatusSourceAdapter();
    this.#runner = new TmuxInstallerRunnerAdapter(this.#statusSource, this.#presenter);
    this.#getStatusUseCase = new GetTmuxStatusUseCase(this.#statusSource);
    this.#getSnapshotUseCase = new GetTmuxInstallerSnapshotUseCase(this.#runner);
    this.#installUseCase = new InstallTmuxUseCase(this.#runner);
    this.#cancelUseCase = new CancelTmuxInstallUseCase(this.#runner);
    this.#submitInputUseCase = new SubmitTmuxInstallerInputUseCase(this.#runner);
  }

  getStatus(): Promise<TmuxStatus> {
    return this.#getStatusUseCase.execute();
  }

  getInstallerSnapshot(): TmuxInstallerSnapshot {
    return this.#getSnapshotUseCase.execute();
  }

  install(): Promise<void> {
    return this.#installUseCase.execute().finally(() => {
      invalidateTmuxRuntimeStatusCache();
    });
  }

  cancelInstall(): Promise<void> {
    return this.#cancelUseCase.execute();
  }

  submitInstallerInput(input: string): Promise<void> {
    return this.#submitInputUseCase.execute(input);
  }

  invalidateStatus(): void {
    this.#statusSource.invalidateStatus();
    invalidateTmuxRuntimeStatusCache();
  }

  setMainWindow(window: BrowserWindow | null): void {
    this.#presenter.setMainWindow(window);
  }
}

export function createTmuxInstallerFeature(): TmuxInstallerFeatureFacade {
  return new TmuxInstallerFeatureFacadeImpl();
}
