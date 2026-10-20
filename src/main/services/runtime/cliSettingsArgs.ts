export type JsonObject = Record<string, unknown>;

type JsonArray = unknown[];

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonSettingsObject(raw: string): JsonObject | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isHookEntry(value: unknown): value is JsonObject {
  return isJsonObject(value) && Array.isArray(value.hooks);
}

function getHookEntryDedupeKey(value: unknown): string | null {
  if (!isHookEntry(value)) {
    return null;
  }

  const hooks = Array.isArray(value.hooks) ? value.hooks : [];
  const commands = hooks
    .map((hook: unknown) =>
      isJsonObject(hook) && typeof hook.command === 'string' ? hook.command : null
    )
    .filter((command): command is string => Boolean(command));
  if (commands.length === 0) {
    return null;
  }

  return JSON.stringify({
    matcher: typeof value.matcher === 'string' ? value.matcher : '',
    commands,
  });
}

function mergeHookEntryArrays(target: JsonArray, source: JsonArray): JsonArray {
  const merged = [...target];
  const seen = new Set<string>();
  for (const entry of merged) {
    const key = getHookEntryDedupeKey(entry);
    if (key) {
      seen.add(key);
    }
  }

  for (const entry of source) {
    const key = getHookEntryDedupeKey(entry);
    if (key && seen.has(key)) {
      continue;
    }
    merged.push(entry);
    if (key) {
      seen.add(key);
    }
  }

  return merged;
}

function mergeConfigOverrideArrays(target: JsonArray, source: JsonArray): JsonArray {
  const getDedupeKey = (value: unknown): string => {
    try {
      return JSON.stringify(value);
    } catch {
      return `${typeof value}:${String(value)}`;
    }
  };
  const merged = [...target];
  const seen = new Set(target.map((value) => getDedupeKey(value)));
  for (const value of source) {
    const key = getDedupeKey(value);
    if (seen.has(key)) {
      continue;
    }
    merged.push(value);
    seen.add(key);
  }
  return merged;
}

function mergeHooksObject(target: JsonObject, source: JsonObject): JsonObject {
  const merged: JsonObject = { ...target };
  for (const [hookName, sourceValue] of Object.entries(source)) {
    const currentValue = merged[hookName];
    if (Array.isArray(currentValue) && Array.isArray(sourceValue)) {
      merged[hookName] = mergeHookEntryArrays(currentValue, sourceValue);
      continue;
    }
    if (isJsonObject(currentValue) && isJsonObject(sourceValue)) {
      merged[hookName] = mergeJsonSettingsObjects(currentValue, sourceValue);
      continue;
    }
    merged[hookName] = sourceValue;
  }
  return merged;
}

export function mergeJsonSettingsObjects(target: JsonObject, source: JsonObject): JsonObject {
  const merged: JsonObject = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const current = merged[key];
    if (key === 'config_overrides' && Array.isArray(current) && Array.isArray(value)) {
      merged[key] = mergeConfigOverrideArrays(current, value);
      continue;
    }
    if (key === 'hooks' && isJsonObject(current) && isJsonObject(value)) {
      merged[key] = mergeHooksObject(current, value);
      continue;
    }
    if (isJsonObject(current) && isJsonObject(value)) {
      merged[key] = mergeJsonSettingsObjects(current, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

/**
 * Native multimodel launches may receive app settings and provider settings as
 * separate --settings JSON values. Some runtimes read only the first one, so
 * collapse parseable JSON settings into one object before spawn.
 */
export function mergeJsonSettingsArgs(args: string[]): string[] {
  let mergedSettings: JsonObject | null = null;
  let firstSettingsIndex: number | null = null;
  const output: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--settings') {
      const value = args[i + 1];
      if (typeof value === 'string') {
        const parsed = parseJsonSettingsObject(value);
        if (parsed) {
          if (firstSettingsIndex === null) {
            firstSettingsIndex = output.length;
          }
          mergedSettings = mergeJsonSettingsObjects(mergedSettings ?? {}, parsed);
          i += 2;
          continue;
        }
      }
      output.push(arg);
      i += 1;
      continue;
    }

    const settingsPrefix = '--settings=';
    if (arg.startsWith(settingsPrefix)) {
      const parsed = parseJsonSettingsObject(arg.slice(settingsPrefix.length));
      if (parsed) {
        if (firstSettingsIndex === null) {
          firstSettingsIndex = output.length;
        }
        mergedSettings = mergeJsonSettingsObjects(mergedSettings ?? {}, parsed);
        i += 1;
        continue;
      }
    }

    output.push(arg);
    i += 1;
  }

  if (firstSettingsIndex !== null && mergedSettings) {
    output.splice(firstSettingsIndex, 0, '--settings', JSON.stringify(mergedSettings));
  }

  return output;
}

export interface ParsedCodexCliSettings {
  forcedLoginMethod: string | null;
  configOverrides: string[];
}

const FORCED_LOGIN_METHOD_TOML_PATTERN = /^forced_login_method\s*=\s*([\s\S]+)$/;

function stripTomlString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Round-trippable extraction of Codex settings from both CLI forms produced by
 * `buildCodexLaunchArgs`: native `-c`/`--config` pairs and inline `--settings`
 * JSON (`codex.*.config_overrides`, `codex.forced_login_method`).
 */
export function parseCodexCliSettingsArgs(args: readonly string[]): ParsedCodexCliSettings {
  let forcedLoginMethod: string | null = null;
  const configOverrides: string[] = [];

  const collectFromSettingsJson = (raw: string): boolean => {
    const parsed = parseJsonSettingsObject(raw);
    if (!parsed) return false;
    const codex = parsed.codex;
    if (!isJsonObject(codex)) return true;
    if (typeof codex.forced_login_method === 'string') {
      forcedLoginMethod = codex.forced_login_method;
    }
    for (const value of Object.values(codex)) {
      if (isJsonObject(value) && Array.isArray(value.config_overrides)) {
        for (const override of value.config_overrides) {
          if (typeof override === 'string') configOverrides.push(override);
        }
      }
    }
    return true;
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--settings' && typeof args[i + 1] === 'string') {
      if (collectFromSettingsJson(args[i + 1])) {
        i += 2;
        continue;
      }
    }
    const settingsPrefix = '--settings=';
    if (arg.startsWith(settingsPrefix) && collectFromSettingsJson(arg.slice(settingsPrefix.length))) {
      i += 1;
      continue;
    }
    if (arg === '-c' || arg === '--config') {
      const value = args[i + 1];
      if (typeof value === 'string') {
        const loginMatch = FORCED_LOGIN_METHOD_TOML_PATTERN.exec(value);
        if (loginMatch) {
          forcedLoginMethod = stripTomlString(loginMatch[1]);
        } else {
          configOverrides.push(value);
        }
        i += 2;
        continue;
      }
    }
    i += 1;
  }

  return { forcedLoginMethod, configOverrides };
}
