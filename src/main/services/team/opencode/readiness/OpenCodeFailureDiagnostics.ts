import { normalizeVersion } from '@shared/utils/version';

export function isOpenCodeTerminalProbeTechnicalDiagnostic(message: string): boolean {
  return (
    message.startsWith('OpenCode prompt start exposed a terminal provider error') ||
    message.startsWith('OpenCode retry status exposed a terminal provider error') ||
    (message.startsWith('OpenCode session ') &&
      message.includes(' request exposed a terminal provider error')) ||
    message.startsWith('OpenCode retry/error payload exposed a terminal provider failure') ||
    message.startsWith('OpenCode assistant payload exposed a terminal provider failure') ||
    message.startsWith('Cursor native failure probe will retry after a transient failure') ||
    message.startsWith('Cursor native execution preflight hit a transient failure') ||
    message.startsWith('Cursor native execution preflight was inconclusive') ||
    message.startsWith('Cursor native failure probe failed:') ||
    message.startsWith('Cursor native failure probe confirmed a terminal provider error')
  );
}

const FREE_TIER_VERSION_REQUIREMENT =
  /\bOpenCode\s+v?(\d{1,5}\.\d{1,5}\.\d{1,5})\s+or newer is required to use the free[\s-]+tier\b/i;
const NORMALIZED_FREE_TIER_VERSION_REQUIREMENT =
  /\bOpenCode free[\s-]+tier models require OpenCode\s+v?(\d{1,5}\.\d{1,5}\.\d{1,5})\s+or newer\b/i;
const NORMALIZED_INSTALLED_VERSION =
  /\bThis app is using OpenCode\s+v?(\d{1,5}\.\d{1,5}\.\d{1,5})\b/i;
const NORMALIZED_BINARY_OVERRIDE =
  /\b(OPENCODE_BIN_PATH|CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH) override pins this version\b/;

export function parseOpenCodeFreeTierRequiredVersion(message: string): string | null {
  return (
    FREE_TIER_VERSION_REQUIREMENT.exec(message)?.[1] ??
    NORMALIZED_FREE_TIER_VERSION_REQUIREMENT.exec(message)?.[1] ??
    null
  );
}

export function buildOpenCodeFreeTierVersionMessage(
  requiredVersion: string,
  installedVersion?: string | null,
  binaryOverrideEnvName?: string
): string {
  return (
    `${installedVersion ? `This app is using OpenCode ${normalizeVersion(installedVersion)}. ` : ''}` +
    `OpenCode free-tier models require OpenCode ${requiredVersion} or newer. ` +
    (binaryOverrideEnvName
      ? `The ${binaryOverrideEnvName} override pins this version. Update that binary or remove the override, then restart Agent Teams.`
      : 'Update the OpenCode runtime from the provider status card before launching this team.')
  );
}

export function formatOpenCodeFreeTierVersionFailure(
  message: string,
  installedVersion?: string | null,
  binaryOverrideEnvName?: string
): string | null {
  const requiredVersion = parseOpenCodeFreeTierRequiredVersion(message);
  return requiredVersion
    ? buildOpenCodeFreeTierVersionMessage(
        requiredVersion,
        installedVersion ?? NORMALIZED_INSTALLED_VERSION.exec(message)?.[1],
        binaryOverrideEnvName ?? NORMALIZED_BINARY_OVERRIDE.exec(message)?.[1]
      )
    : null;
}
