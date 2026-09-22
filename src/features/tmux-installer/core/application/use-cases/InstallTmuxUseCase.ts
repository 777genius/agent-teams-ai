import type { TmuxInstallerRunnerPort } from '../ports/TmuxInstallerRunnerPort';

export class InstallTmuxUseCase {
  readonly #runner: TmuxInstallerRunnerPort;

  constructor(runner: TmuxInstallerRunnerPort) {
    this.#runner = runner;
  }

  execute(): Promise<void> {
    return this.#runner.install();
  }
}
