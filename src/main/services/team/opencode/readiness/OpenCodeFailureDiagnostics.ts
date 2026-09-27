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

export function parseOpenCodeFreeTierRequiredVersion(message: string): string | null {
  return (
    FREE_TIER_VERSION_REQUIREMENT.exec(message)?.[1] ??
    NORMALIZED_FREE_TIER_VERSION_REQUIREMENT.exec(message)?.[1] ??
    null
  );
}

export function buildOpenCodeFreeTierVersionMessage(
  requiredVersion: string,
  installedVersion?: string | null
): string {
  return (
    `${installedVersion ? `This app is using OpenCode ${normalizeVersion(installedVersion)}. ` : ''}` +
    `OpenCode free-tier models require OpenCode ${requiredVersion} or newer. ` +
    'Update the OpenCode runtime from the provider status card before launching this team.'
  );
}

export function formatOpenCodeFreeTierVersionFailure(
  message: string,
  installedVersion?: string | null
): string | null {
  const requiredVersion = parseOpenCodeFreeTierRequiredVersion(message);
  return requiredVersion
    ? buildOpenCodeFreeTierVersionMessage(requiredVersion, installedVersion)
    : null;
}
