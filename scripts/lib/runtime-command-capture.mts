import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process';

type RuntimeCommandRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding
) => Pick<SpawnSyncReturns<string>, 'error' | 'status' | 'stdout' | 'stderr'>;

/** Capture bootstrap command output through the caller's platform-aware synchronous runner. */
export function createRuntimeCommandCapture(run: RuntimeCommandRunner) {
  return (
    cmd: string,
    args: string[],
    options: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'> = {}
  ): string => {
    const result = run(cmd, args, { encoding: 'utf8', ...options });
    if (result.error) throw new Error(`Failed to run ${cmd}: ${result.error.message}`);
    if (result.status !== 0) {
      const details = [result.stdout, result.stderr]
        .map((value) => value?.trim())
        .filter(Boolean)
        .join('\n');
      throw new Error(`Command failed: ${cmd} ${args.join(' ')}${details ? `\n${details}` : ''}`);
    }
    return result.stdout?.trim() ?? '';
  };
}
