import type {
  TeamProvisioningPrepareResult,
  ValidatedProvisioningPrepareInput,
} from '../models/TeamProvisioningModels';
import type { TeamProvisioningPreflightPort } from '../ports/TeamProvisioningPorts';

export interface ProvisioningCliArgsValidationResult {
  valid: boolean;
  invalidFlags?: string[];
}

const PROTECTED_CLI_FLAGS = new Set([
  '--input-format',
  '--output-format',
  '--setting-sources',
  '--mcp-config',
  '--disallowedTools',
  '--verbose',
  '--model',
  '--effort',
  '--teammate-mode',
  '--resume',
  '--settings',
  '--permission-mode',
  '--permission-prompt-tool',
  '--dangerously-skip-permissions',
]);

export class CheckProvisioningPreflight {
  constructor(private readonly preflight: TeamProvisioningPreflightPort) {}

  async validateCliArgs(rawArgs: string): Promise<ProvisioningCliArgsValidationResult> {
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

function extractFlagsFromHelp(helpOutput: string): Set<string> {
  const flags = new Set<string>();
  for (const pattern of [
    /(?:^|[\s,])(-{2}[a-zA-Z][a-zA-Z0-9-]*)/gm,
    /(?:^|[\s,])(-[a-zA-Z])\b/gm,
  ]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(helpOutput)) !== null) {
      flags.add(match[1]);
    }
  }
  return flags;
}

function extractUserFlags(raw: string): string[] {
  const flags: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  const push = (): void => {
    if (current.startsWith('-')) flags.push(current.split('=', 1)[0]);
    current = '';
  };
  for (const character of raw) {
    if ((character === "'" || character === '"') && (quote === null || quote === character)) {
      quote = quote === null ? character : null;
    } else if ((character === ' ' || character === '\t') && quote === null) {
      push();
    } else {
      current += character;
    }
  }
  push();
  return flags;
}
