import { execCli } from '@main/utils/childProcess';
import { createLogger } from '@shared/utils/logger';

export const CODEX_RUNTIME_VERSION_TIMEOUT_MS = 10_000;

const logger = createLogger('CodexRuntimeInstallerService');

export async function probeManagedCodexVersion(binaryPath: string): Promise<string> {
  const probe = async (attempt: number): Promise<string> => {
    try {
      const { stdout } = await execCli(binaryPath, ['--version'], {
        timeout: CODEX_RUNTIME_VERSION_TIMEOUT_MS,
        windowsHide: true,
      });
      return stdout;
    } catch (error) {
      const failure = error as { code?: string | number; signal?: string } | null;
      const timedOut =
        failure?.code === 'ETIMEDOUT' ||
        (error instanceof Error &&
          error.message ===
            `Command timed out after ${CODEX_RUNTIME_VERSION_TIMEOUT_MS}ms: ${binaryPath} --version`);
      const retrying = attempt === 1 && timedOut;
      // Raw errors can include child output; diagnostics deliberately record metadata only.
      logger.warn('Managed Codex version probe failed', {
        binaryPath,
        attempt,
        timedOut,
        code: failure?.code,
        signal: failure?.signal,
        retrying,
      });
      if (!retrying) {
        throw error;
      }
      return probe(2);
    }
  };
  return probe(1);
}
