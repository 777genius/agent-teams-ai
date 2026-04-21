import { applyOpenCodeAutoUpdatePolicy } from '@main/services/runtime/openCodeAutoUpdatePolicy';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface OpenCodeMcpServerConfig {
  type: 'local' | 'remote';
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  environment?: Record<string, string>;
  timeout?: number;
}

export type OpenCodeBehaviorSourceKind =
  | 'global_config'
  | 'project_config'
  | 'global_plugin_dir'
  | 'project_plugin_dir'
  | 'project_opencode_dir';

export interface OpenCodeBehaviorSource {
  kind: OpenCodeBehaviorSourceKind;
  pathHash: string;
  exists: boolean;
  fingerprint: string | null;
  fileCount: number;
}

export interface OpenCodeManagedOverlay {
  launchMode: 'project_root_with_inline_overlay';
  projectPath: string;
  env: {
    OPENCODE_CONFIG_CONTENT: string;
    OPENCODE_DISABLE_AUTOUPDATE?: '1';
  };
  appMcpServerName: string;
  appMcpConfig: OpenCodeMcpServerConfig;
  preservedSources: OpenCodeBehaviorSource[];
  diagnostics: string[];
}

export interface OpenCodeManagedOverlayBuilderInput {
  projectPath: string;
  preferredMcpName: string;
  appMcpCommand: string;
  appMcpArgs: string[];
  appMcpEnv: Record<string, string>;
  mcpTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface OpenCodeBehaviorSourceScannerOptions {
  homePath?: string;
  maxDirectoryFiles?: number;
}

const FORBIDDEN_MANAGED_OVERLAY_TOP_LEVEL_KEYS = [
  'plugin',
  'plugins',
  'agent',
  'command',
  'instructions',
  'formatter',
  'lsp',
  'theme',
  'keybinds',
  'model',
  'mode',
  'provider',
  'tools',
  'skills',
] as const;

export class OpenCodeManagedOverlayBuilder {
  constructor(
    private readonly behaviorSourceScanner = new OpenCodeBehaviorSourceScanner(),
    private readonly clock: () => Date = () => new Date()
  ) {}

  async build(input: OpenCodeManagedOverlayBuilderInput): Promise<OpenCodeManagedOverlay> {
    const preservedSources = await this.behaviorSourceScanner.scan(input.projectPath);
    const existingMcpNames = await this.behaviorSourceScanner.readDeclaredMcpNames(
      input.projectPath
    );
    const appMcpServerName = pickAppOwnedMcpServerName(input.preferredMcpName, existingMcpNames);
    const overlayConfig = buildManagedOverlayConfig({
      serverName: appMcpServerName,
      command: input.appMcpCommand,
      args: input.appMcpArgs,
      environment: input.appMcpEnv,
      timeout: input.mcpTimeoutMs ?? 10_000,
    });

    assertManagedOverlayDoesNotShadowUserConfig(overlayConfig);

    return {
      launchMode: 'project_root_with_inline_overlay',
      projectPath: input.projectPath,
      env: applyOpenCodeAutoUpdatePolicy(
        {
          OPENCODE_CONFIG_CONTENT: JSON.stringify(overlayConfig),
        },
        input.env ?? process.env
      ),
      appMcpServerName,
      appMcpConfig: overlayConfig.mcp[appMcpServerName],
      preservedSources,
      diagnostics: buildOverlayDiagnostics({
        preferredMcpName: input.preferredMcpName,
        appMcpServerName,
        existingMcpNames,
        preservedSources,
        checkedAt: this.clock().toISOString(),
      }),
    };
  }
}

export class OpenCodeBehaviorSourceScanner {
  private readonly homePath: string;
  private readonly maxDirectoryFiles: number;

  constructor(options: OpenCodeBehaviorSourceScannerOptions = {}) {
    this.homePath = options.homePath ?? os.homedir();
    this.maxDirectoryFiles = options.maxDirectoryFiles ?? 200;
  }

  async scan(projectPath: string): Promise<OpenCodeBehaviorSource[]> {
    const sourceSpecs: { kind: OpenCodeBehaviorSourceKind; targetPath: string }[] = [
      {
        kind: 'global_config',
        targetPath: path.join(this.homePath, '.config/opencode/opencode.json'),
      },
      { kind: 'project_config', targetPath: path.join(projectPath, 'opencode.json') },
      { kind: 'project_config', targetPath: path.join(projectPath, 'opencode.jsonc') },
      {
        kind: 'global_plugin_dir',
        targetPath: path.join(this.homePath, '.config/opencode/plugins'),
      },
      { kind: 'project_plugin_dir', targetPath: path.join(projectPath, '.opencode/plugins') },
      { kind: 'project_opencode_dir', targetPath: path.join(projectPath, '.opencode') },
    ];

    return Promise.all(sourceSpecs.map((source) => this.fingerprintSource(source)));
  }

  async readDeclaredMcpNames(projectPath: string): Promise<Set<string>> {
    const configPaths = [
      path.join(this.homePath, '.config/opencode/opencode.json'),
      path.join(projectPath, 'opencode.json'),
      path.join(projectPath, 'opencode.jsonc'),
      path.join(projectPath, '.opencode/opencode.json'),
      path.join(projectPath, '.opencode/opencode.jsonc'),
    ];
    const names = new Set<string>();

    for (const configPath of configPaths) {
      const config = await this.readConfig(configPath);
      const mcp = asRecord(config?.mcp);
      for (const name of Object.keys(mcp ?? {})) {
        names.add(name);
      }
    }

    return names;
  }

  private async fingerprintSource(input: {
    kind: OpenCodeBehaviorSourceKind;
    targetPath: string;
  }): Promise<OpenCodeBehaviorSource> {
    const pathHash = hashText(input.targetPath);
    let stat;
    try {
      stat = await fs.stat(input.targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          kind: input.kind,
          pathHash,
          exists: false,
          fingerprint: null,
          fileCount: 0,
        };
      }
      throw error;
    }

    if (stat.isFile()) {
      const content = await fs.readFile(input.targetPath);
      return {
        kind: input.kind,
        pathHash,
        exists: true,
        fingerprint: hashText(`${stat.size}:${stat.mtimeMs}:${hashBuffer(content)}`),
        fileCount: 1,
      };
    }

    if (stat.isDirectory()) {
      const entries = await this.listDirectoryFiles(input.targetPath);
      return {
        kind: input.kind,
        pathHash,
        exists: true,
        fingerprint: hashJson(
          entries.map((entry) => ({
            relativePath: entry.relativePath,
            size: entry.size,
            mtimeMs: entry.mtimeMs,
            contentHash: entry.contentHash,
          }))
        ),
        fileCount: entries.length,
      };
    }

    return {
      kind: input.kind,
      pathHash,
      exists: true,
      fingerprint: hashText(`${stat.size}:${stat.mtimeMs}:unsupported`),
      fileCount: 0,
    };
  }

  private async listDirectoryFiles(rootPath: string): Promise<
    {
      relativePath: string;
      size: number;
      mtimeMs: number;
      contentHash: string;
    }[]
  > {
    const results: {
      relativePath: string;
      size: number;
      mtimeMs: number;
      contentHash: string;
    }[] = [];

    const visit = async (directoryPath: string): Promise<void> => {
      if (results.length >= this.maxDirectoryFiles) {
        return;
      }

      const entries = await fs.readdir(directoryPath, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= this.maxDirectoryFiles) {
          return;
        }

        const absolutePath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          await visit(absolutePath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }

        const stat = await fs.stat(absolutePath);
        const content = await fs.readFile(absolutePath);
        results.push({
          relativePath: path.relative(rootPath, absolutePath),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          contentHash: hashBuffer(content),
        });
      }
    };

    await visit(rootPath);
    return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  private async readConfig(configPath: string): Promise<Record<string, unknown> | null> {
    let text: string;
    try {
      text = await fs.readFile(configPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(stripJsonComments(text)) as unknown;
      return asRecord(parsed);
    } catch {
      return null;
    }
  }
}

export function buildManagedOverlayConfig(input: {
  serverName: string;
  command: string;
  args: string[];
  environment: Record<string, string>;
  timeout: number;
}): { mcp: Record<string, OpenCodeMcpServerConfig> } {
  return {
    mcp: {
      [input.serverName]: {
        type: 'local',
        command: input.command,
        args: input.args,
        enabled: true,
        environment: input.environment,
        timeout: input.timeout,
      },
    },
  };
}

export function assertManagedOverlayDoesNotShadowUserConfig(config: Record<string, unknown>): void {
  const usedForbiddenKeys = FORBIDDEN_MANAGED_OVERLAY_TOP_LEVEL_KEYS.filter((key) => key in config);
  if (usedForbiddenKeys.length > 0) {
    throw new Error(
      `Managed OpenCode overlay must not set user behavior keys: ${usedForbiddenKeys.join(', ')}`
    );
  }
}

export function pickAppOwnedMcpServerName(preferred: string, existingNames: Set<string>): string {
  if (!existingNames.has(preferred)) {
    return preferred;
  }

  let index = 1;
  while (existingNames.has(`${preferred}-runtime-${index}`)) {
    index += 1;
  }

  return `${preferred}-runtime-${index}`;
}

function buildOverlayDiagnostics(input: {
  preferredMcpName: string;
  appMcpServerName: string;
  existingMcpNames: Set<string>;
  preservedSources: OpenCodeBehaviorSource[];
  checkedAt: string;
}): string[] {
  const diagnostics = [
    `OpenCode managed overlay checked at ${input.checkedAt}`,
    `OpenCode preserved behavior sources: ${input.preservedSources.filter((source) => source.exists).length}`,
  ];

  if (input.appMcpServerName !== input.preferredMcpName) {
    diagnostics.push(
      `User OpenCode config already declares MCP server "${input.preferredMcpName}"; managed runtime will use "${input.appMcpServerName}"`
    );
  }

  if (input.existingMcpNames.size > 0) {
    diagnostics.push(
      `OpenCode existing MCP server names observed: ${[...input.existingMcpNames].sort().join(', ')}`
    );
  }

  return diagnostics;
}

function stripJsonComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, (_match, prefix: string) => prefix);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hashJson(value: unknown): string {
  return hashText(stableJsonStringify(value));
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashBuffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJsonStringify(item)}`)
    .join(',')}}`;
}
