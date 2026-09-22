import type { TmuxInstallerRunnerPort } from '../ports/TmuxInstallerRunnerPort';

export class SubmitTmuxInstallerInputUseCase {
  readonly #runner: TmuxInstallerRunnerPort;

  constructor(runner: TmuxInstallerRunnerPort) {
    this.#runner = runner;
  }

  execute(input: string): Promise<void> {
    return this.#runner.submitInput(input);
  }
}
