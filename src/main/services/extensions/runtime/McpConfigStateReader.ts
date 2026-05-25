import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getHomeDir } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import type { InstalledMcpEntry } from '@shared/types/extensions';

const logger = createLogger('Extensions:McpConfigStateReader');

export interface ConfiguredMcpEntry extends InstalledMcpEntry {
  scope: 'local' | 'user' | 'project';
  config: Record<string, unknown>;
}

export class McpConfigStateReader {
  async readInstalled(projectPath?: string): Promise<InstalledMcpEntry[]> {
    const entries: InstalledMcpEntry[] = [];
    const claudeConfig = await this.readClaudeConfig();

    entries.push(...this.readUserMcpServers(claudeConfig));

    if (projectPath) {
      entries.push(...this.readLocalMcpServers(claudeConfig, projectPath));
      entries.push(...(await this.readProjectMcpServers(projectPath)));
    }

    return entries;
  }

  async readConfigured(projectPath?: string): Promise<ConfiguredMcpEntry[]> {
    const entries: ConfiguredMcpEntry[] = [];
    const claudeConfig = await this.readClaudeConfig();

    entries.push(...this.readConfiguredMcpServersFromConfig(claudeConfig?.mcpServers, 'user'));

    if (projectPath) {
      entries.push(...this.readLocalConfiguredMcpServers(claudeConfig, projectPath));
      entries.push(...(await this.readProjectConfiguredMcpServers(projectPath)));
    }

    return entries;
  }

  private async readClaudeConfig(): Promise<Record<string, unknown> | null> {
    const configPath = path.join(getHomeDir(), '.claude.json');
    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      logger.error(`Failed to read MCP servers from ${configPath}:`, err);
      return null;
    }
  }

  private readUserMcpServers(config: Record<string, unknown> | null): InstalledMcpEntry[] {
    return this.readMcpServersFromConfig(config?.mcpServers, 'user');
  }

  private readLocalMcpServers(
    config: Record<string, unknown> | null,
    projectPath: string
  ): InstalledMcpEntry[] {
    return this.readLocalConfiguredMcpServers(config, projectPath).map(
      ({ config: _config, ...entry }) => entry
    );
  }

  private readLocalConfiguredMcpServers(
    config: Record<string, unknown> | null,
    projectPath: string
  ): ConfiguredMcpEntry[] {
    const projects =
      config && typeof config.projects === 'object' && config.projects
        ? (config.projects as Record<string, unknown>)
        : null;
    const projectConfig =
      projects && typeof projects[projectPath] === 'object' && projects[projectPath]
        ? (projects[projectPath] as Record<string, unknown>)
        : null;
    return this.readConfiguredMcpServersFromConfig(projectConfig?.mcpServers, 'local');
  }

  private async readProjectMcpServers(projectPath: string): Promise<InstalledMcpEntry[]> {
    const configPath = path.join(projectPath, '.mcp.json');
    return this.readMcpServersFromFile(configPath, 'project');
  }

  private async readProjectConfiguredMcpServers(
    projectPath: string
  ): Promise<ConfiguredMcpEntry[]> {
    const configPath = path.join(projectPath, '.mcp.json');
    return this.readConfiguredMcpServersFromFile(configPath, 'project');
  }

  private readMcpServersFromConfig(
    value: unknown,
    scope: 'user' | 'project' | 'local'
  ): InstalledMcpEntry[] {
    const mcpServers =
      value && typeof value === 'object'
        ? (value as Record<string, { command?: string; url?: string }>)
        : null;
    if (!mcpServers) {
      return [];
    }

    return Object.entries(mcpServers).map(([name, config]): InstalledMcpEntry => {
      let transport: string | undefined;
      if (config.command) transport = 'stdio';
      else if (config.url) transport = 'http';

      return { name, scope, transport };
    });
  }

  private readConfiguredMcpServersFromConfig(
    value: unknown,
    scope: 'user' | 'project' | 'local'
  ): ConfiguredMcpEntry[] {
    const mcpServers =
      value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    if (!mcpServers) {
      return [];
    }

    return Object.entries(mcpServers)
      .filter((entry): entry is [string, Record<string, unknown>] => {
        const [, config] = entry;
        return Boolean(config && typeof config === 'object' && !Array.isArray(config));
      })
      .map(([name, config]): ConfiguredMcpEntry => {
        let transport: string | undefined;
        if (typeof config.command === 'string') transport = 'stdio';
        else if (typeof config.url === 'string') transport = 'http';

        return { name, scope, transport, config: { ...config } };
      });
  }

  private async readMcpServersFromFile(
    filePath: string,
    scope: 'user' | 'project'
  ): Promise<InstalledMcpEntry[]> {
    return (await this.readConfiguredMcpServersFromFile(filePath, scope)).map(
      ({ config: _config, ...entry }) => entry
    );
  }

  private async readConfiguredMcpServersFromFile(
    filePath: string,
    scope: 'user' | 'project'
  ): Promise<ConfiguredMcpEntry[]> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const json = JSON.parse(raw) as Record<string, unknown>;
      return this.readConfiguredMcpServersFromConfig(json.mcpServers, scope);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.error(`Failed to read MCP servers from ${filePath}:`, err);
      return [];
    }
  }
}
