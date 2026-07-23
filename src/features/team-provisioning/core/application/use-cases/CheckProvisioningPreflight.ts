import {
  extractFlagsFromHelp,
  extractUserFlags,
  PROTECTED_CLI_FLAGS,
} from '@shared/utils/cliArgsParser';

import type { ValidatedProvisioningPrepareInput } from '../models/TeamProvisioningModels';
import type { TeamProvisioningPreflightPort } from '../ports/TeamProvisioningPorts';
import type { TeamProvisioningPrepareResult } from '@shared/types';
import type { CliArgsValidationResult } from '@shared/utils/cliArgsParser';

export class CheckProvisioningPreflight {
  constructor(private readonly preflight: TeamProvisioningPreflightPort) {}

  async validateCliArgs(rawArgs: string): Promise<CliArgsValidationResult> {
    const helpOutput = await this.preflight.getCliHelpOutput();
    const knownFlags = extractFlagsFromHelp(helpOutput);
    const userFlags = extractUserFlags(rawArgs);
    const invalidFlags = userFlags.filter((flag) => !knownFlags.has(flag));
    const protectedFlags = userFlags.filter((flag) => PROTECTED_CLI_FLAGS.has(flag));
    const allInvalidFlags = [...new Set([...invalidFlags, ...protectedFlags])];
    return {
      valid: allInvalidFlags.length === 0,
      invalidFlags: allInvalidFlags.length > 0 ? allInvalidFlags : undefined,
    };
  }

  prepare(input: ValidatedProvisioningPrepareInput): Promise<TeamProvisioningPrepareResult> {
    return this.preflight.prepareForProvisioning(input.cwd, {
      providerId: input.providerId,
      providerIds: input.providerIds,
      modelIds: input.selectedModels,
      limitContext: input.limitContext,
      modelVerificationMode: input.modelVerificationMode,
      modelChecks: input.selectedModelChecks,
    });
  }
}
