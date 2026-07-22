import * as path from 'path';

export interface ClaudePermissionSettingsFilePorts {
  mkdirRecursive(directoryPath: string): Promise<void>;
  readFileUtf8(filePath: string): Promise<string>;
  writeFileUtf8(filePath: string, contents: string): Promise<void>;
}

export interface ClaudePermissionSettingsLoggerPort {
  info(message: string): void;
  warn(message: string): void;
}

export interface AddPermissionRulesToSettingsInput {
  settingsPath: string;
  toolNames: string[];
  behavior: string;
}

export interface SeedLeadBootstrapPermissionRulesInput {
  teamName: string;
  projectCwd: string;
  bootstrapToolNames: readonly string[];
}

const LEAD_BOOTSTRAP_CLAUDE_TOOL_NAMES = ['Edit', 'Write', 'NotebookEdit'] as const;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function addPermissionRulesToSettings(
  input: AddPermissionRulesToSettingsInput,
  ports: ClaudePermissionSettingsFilePorts
): Promise<number> {
  const dir = path.dirname(input.settingsPath);
  await ports.mkdirRecursive(dir);

  let settings: Record<string, unknown> = {};
  try {
    const raw = await ports.readFileUtf8(input.settingsPath);
    const parsed = JSON.parse(raw) as unknown;
    if (isJsonObject(parsed)) {
      settings = parsed;
    }
  } catch {
    // File doesn't exist or invalid JSON - start fresh.
  }

  if (!isJsonObject(settings.permissions)) {
    settings.permissions = {};
  }
  const perms = settings.permissions as Record<string, unknown>;

  const key = input.behavior === 'deny' ? 'deny' : 'allow';
  if (!Array.isArray(perms[key])) {
    perms[key] = [];
  }
  const list = perms[key] as string[];

  const existing = new Set(list);
  let added = 0;
  for (const name of input.toolNames) {
    if (!existing.has(name)) {
      list.push(name);
      added++;
    }
  }

  if (added === 0) return 0;

  await ports.writeFileUtf8(input.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return added;
}

export async function seedLeadBootstrapPermissionRules(
  input: SeedLeadBootstrapPermissionRulesInput,
  ports: ClaudePermissionSettingsFilePorts & { logger: ClaudePermissionSettingsLoggerPort }
): Promise<void> {
  const settingsPath = path.join(input.projectCwd, '.claude', 'settings.local.json');
  try {
    const allTools = [...input.bootstrapToolNames, ...LEAD_BOOTSTRAP_CLAUDE_TOOL_NAMES];
    const added = await addPermissionRulesToSettings(
      { settingsPath, toolNames: allTools, behavior: 'allow' },
      ports
    );
    ports.logger.info(
      `[${input.teamName}] Seeded lead bootstrap MCP rules in ${settingsPath} (${added} added)`
    );
  } catch (error) {
    ports.logger.warn(
      `[${input.teamName}] Failed to seed lead bootstrap MCP rules: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
