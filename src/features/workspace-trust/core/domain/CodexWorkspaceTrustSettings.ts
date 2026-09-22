import { normalizeWorkspaceTrustConfigKey } from './WorkspaceTrustPath';

import type { WorkspaceTrustPathOptions } from './WorkspaceTrustPath';

export const CODEX_WORKSPACE_TRUST_SETTINGS_ROOT = 'codex';
export const CODEX_WORKSPACE_TRUST_SETTINGS_KEY = 'agent_teams_workspace_trust';
export const CODEX_WORKSPACE_TRUST_CONFIG_OVERRIDES_KEY = 'config_overrides';

const CODEX_WORKSPACE_TRUST_OVERRIDE_PATTERN =
  /^projects\."(?:[^"\\\x00-\x1F]|\\["\\bfnrt]|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8})+"\.trust_level="trusted"$/;

export interface CodexWorkspaceTrustSettingsObject {
  codex: {
    agent_teams_workspace_trust: {
      config_overrides: string[];
    };
  };
}

function toHex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0').toUpperCase();
}

export function escapeTomlBasicStringSegment(value: string): string {
  let output = '';
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (char === '"') {
      output += '\\"';
    } else if (char === '\\') {
      output += '\\\\';
    } else if (char === '\b') {
      output += '\\b';
    } else if (char === '\t') {
      output += '\\t';
    } else if (char === '\n') {
      output += '\\n';
    } else if (char === '\f') {
      output += '\\f';
    } else if (char === '\r') {
      output += '\\r';
    } else if (codePoint < 0x20) {
      output += `\\u${toHex(codePoint, 4)}`;
    } else {
      output += char;
    }
  }
  return output;
}

export function buildCodexTrustedProjectConfigOverride(configKey: string): string | null {
  const trimmed = configKey.trim();
  if (!trimmed) {
    return null;
  }
  return `projects."${escapeTomlBasicStringSegment(trimmed)}".trust_level="trusted"`;
}

export function isCodexWorkspaceTrustConfigOverride(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 1024 &&
    !value.includes('\0') &&
    !value.includes('\n') &&
    !value.includes('\r') &&
    CODEX_WORKSPACE_TRUST_OVERRIDE_PATTERN.test(value)
  );
}

export function buildCodexTrustedProjectConfigOverrides(
  configKeys: string[],
  options?: WorkspaceTrustPathOptions & { maxOverrides?: number }
): string[] {
  const maxOverrides = Math.max(0, options?.maxOverrides ?? 64);
  const output: string[] = [];
  const seen = new Set<string>();

  for (const key of configKeys) {
    if (output.length >= maxOverrides) {
      break;
    }
    const normalizedKey = normalizeWorkspaceTrustConfigKey(key, options);
    if (!normalizedKey || seen.has(normalizedKey)) {
      continue;
    }
    seen.add(normalizedKey);
    const override = buildCodexTrustedProjectConfigOverride(normalizedKey);
    if (override && isCodexWorkspaceTrustConfigOverride(override)) {
      output.push(override);
    }
  }

  return output;
}

export function normalizeCodexWorkspaceTrustConfigOverrides(
  overrides: readonly unknown[],
  options?: { maxOverrides?: number; maxTotalLength?: number }
): string[] {
  const maxOverrides = Math.max(0, options?.maxOverrides ?? 64);
  const maxTotalLength = Math.max(0, options?.maxTotalLength ?? 16384);
  const output: string[] = [];
  const seen = new Set<string>();
  let totalLength = 0;

  for (const override of overrides) {
    if (output.length >= maxOverrides) {
      break;
    }
    if (!isCodexWorkspaceTrustConfigOverride(override) || seen.has(override)) {
      continue;
    }
    const nextLength = totalLength + override.length;
    if (nextLength > maxTotalLength) {
      break;
    }
    seen.add(override);
    output.push(override);
    totalLength = nextLength;
  }

  return output;
}

export function buildCodexWorkspaceTrustSettings(
  overrides: readonly unknown[]
): CodexWorkspaceTrustSettingsObject | null {
  const safeOverrides = normalizeCodexWorkspaceTrustConfigOverrides(overrides);
  if (safeOverrides.length === 0) {
    return null;
  }
  return {
    codex: {
      agent_teams_workspace_trust: {
        config_overrides: safeOverrides,
      },
    },
  };
}

export function buildCodexWorkspaceTrustSettingsArgs(overrides: readonly unknown[]): string[] {
  const settings = buildCodexWorkspaceTrustSettings(overrides);
  return settings ? ['--settings', JSON.stringify(settings)] : [];
}

export function readCodexWorkspaceTrustConfigOverridesFromSettings(settings: unknown): string[] {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return [];
  }
  const codex = (settings as Record<string, unknown>)[CODEX_WORKSPACE_TRUST_SETTINGS_ROOT];
  if (typeof codex !== 'object' || codex === null || Array.isArray(codex)) {
    return [];
  }
  const workspaceTrust = (codex as Record<string, unknown>)[CODEX_WORKSPACE_TRUST_SETTINGS_KEY];
  if (
    typeof workspaceTrust !== 'object' ||
    workspaceTrust === null ||
    Array.isArray(workspaceTrust)
  ) {
    return [];
  }
  const overrides = (workspaceTrust as Record<string, unknown>)[
    CODEX_WORKSPACE_TRUST_CONFIG_OVERRIDES_KEY
  ];
  return Array.isArray(overrides) ? normalizeCodexWorkspaceTrustConfigOverrides(overrides) : [];
}
