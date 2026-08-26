import {
  extractFlagsFromHelp,
  extractUserFlags,
  PROTECTED_CLI_FLAGS,
} from '@shared/utils/cliArgsParser';

import type { IpcResult } from '@shared/types';
import type { CliArgsValidationResult } from '@shared/utils/cliArgsParser';

export async function validateCliArgsRequest(
  rawArgs: unknown,
  getHelpOutput: () => Promise<string>,
  run: (
    operation: () => Promise<CliArgsValidationResult>
  ) => Promise<IpcResult<CliArgsValidationResult>>
): Promise<IpcResult<CliArgsValidationResult>> {
  if (typeof rawArgs !== 'string') {
    return { success: false, error: 'rawArgs must be a string' };
  }
  if (rawArgs.length > 2048) {
    return { success: false, error: 'rawArgs too long (max 2048)' };
  }
  return run(async () => {
    const knownFlags = extractFlagsFromHelp(await getHelpOutput());
    const userFlags = extractUserFlags(rawArgs);
    const invalidFlags = userFlags.filter((flag) => !knownFlags.has(flag));
    const protectedFlags = userFlags.filter((flag) => PROTECTED_CLI_FLAGS.has(flag));
    const allBad = [...new Set([...invalidFlags, ...protectedFlags])];
    return {
      valid: allBad.length === 0,
      invalidFlags: allBad.length > 0 ? allBad : undefined,
    };
  });
}
