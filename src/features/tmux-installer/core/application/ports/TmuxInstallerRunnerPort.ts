export interface TmuxInstallerRunnerPort {
  install(): Promise<void>;
  cancel(): Promise<void>;
  submitInput(input: string): Promise<void>;
}
