/** Portable tokenizer and advisory validation retain one authoritative implementation. */
export type { CliArgsValidationResult } from '@agent-teams/legacy-agent-host/cli-args';
export {
  extractFlagsFromHelp,
  extractUserFlags,
  findInvalidUserFlags,
  findOptionMissingValue,
  findProtectedUserFlags,
  parseCliArgs,
  PROTECTED_CLI_FLAGS,
} from '@agent-teams/legacy-agent-host/cli-args';
