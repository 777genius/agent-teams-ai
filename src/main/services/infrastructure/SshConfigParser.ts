/**
 * SshConfigParser - Parses ~/.ssh/config to resolve host aliases.
 *
 * Responsibilities:
 * - Parse SSH config with Include directive support
 * - Return all defined Host aliases (excluding wildcards)
 * - Resolve alias to HostName, Port, User, IdentityFile
 * - Gracefully handle missing/unreadable files
 */

import { getHomeDir } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';
import SSHConfig from 'ssh-config';

import type { SshConfigHostEntry } from '@shared/types';

const logger = createLogger('Infrastructure:SshConfigParser');

export class SshConfigParser {
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? path.join(getHomeDir(), '.ssh', 'config');
  }

  /**
   * Returns all defined Host aliases (excluding `*` wildcards and patterns).
   */
  async getHosts(): Promise<SshConfigHostEntry[]> {
    try {
      const config = await this.parseConfig();
      if (!config) return [];

      const entries: SshConfigHostEntry[] = [];

      for (const section of config) {
        if (section.type !== SSHConfig.DIRECTIVE) continue;
        if (section.param !== 'Host') continue;

        const hostValue = section.value;
        if (typeof hostValue !== 'string') continue;

        // Skip wildcard-only entries and patterns with * or ?
        const aliases = hostValue.split(/\s+/).filter((h) => !h.includes('*') && !h.includes('?'));

        for (const alias of aliases) {
          const resolved = this.resolveFromConfig(config, alias);
          entries.push(resolved);
        }
      }

      return entries;
    } catch (err) {
      logger.error('Failed to get SSH config hosts:', err);
      return [];
    }
  }

  /**
   * Resolves a host alias to its SSH config values.
   * Returns null if the alias is not found in config.
   */
  async resolveHost(alias: string): Promise<SshConfigHostEntry | null> {
    try {
      const config = await this.parseConfig();
      if (!config) return null;

      const resolved = this.resolveFromConfig(config, alias);

      // If nothing was resolved beyond the alias itself, check if host was actually defined
      if (!resolved.hostName && !resolved.user && !resolved.port && !resolved.hasIdentityFile) {
        // Check if there's an explicit Host entry for this alias
        const hasEntry = config.some(
          (section) =>
            section.type === SSHConfig.DIRECTIVE &&
            section.param === 'Host' &&
            typeof section.value === 'string' &&
            section.value.split(/\s+/).includes(alias)
        );
        if (!hasEntry) return null;
      }

      return resolved;
    } catch (err) {
      logger.error(`Failed to resolve SSH host "${alias}":`, err);
      return null;
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private resolveFromConfig(config: SSHConfig, alias: string): SshConfigHostEntry {
    const computed = config.compute(alias);

    const rawHostName = computed.HostName;
    const hostName = Array.isArray(rawHostName) ? rawHostName[0] : rawHostName;
    const rawUser = computed.User;
    const user = Array.isArray(rawUser) ? rawUser[0] : (rawUser ?? undefined);
    const portStr = computed.Port;
    const port = portStr ? parseInt(String(portStr), 10) : undefined;
    const identityFile = computed.IdentityFile;
    const hasIdentityFile = Array.isArray(identityFile)
      ? identityFile.length > 0
      : identityFile != null;

    return {
      alias,
      hostName: hostName && hostName !== alias ? hostName : undefined,
      user,
      port: port && port !== 22 ? port : undefined,
      hasIdentityFile,
    };
  }

  private async parseConfig(): Promise<SSHConfig | null> {
    try {
      let content = await fs.promises.readFile(this.configPath, 'utf8');

      // Process Include directives by expanding them inline
      content = await this.expandIncludes(content);

      return SSHConfig.parse(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('No SSH config file found at', this.configPath);
      } else {
        logger.error('Failed to parse SSH config:', err);
      }
      return null;
    }
  }

  private async expandIncludes(content: string): Promise<string> {
    const lines = content.split('\n');
    const result: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      const match =
        trimmed.startsWith('Include ') || trimmed.startsWith('include ')
          ? /^[Ii]nclude\s+(\S.*)$/.exec(trimmed)
          : null;

      if (!match) {
        result.push(line);
        continue;
      }

      const pattern = match[1].trim();
      const expandedPattern = pattern.replace(/^~/, getHomeDir());

      try {
        // Handle glob-like patterns by checking if the path contains wildcards
        if (expandedPattern.includes('*') || expandedPattern.includes('?')) {
          const dir = path.dirname(expandedPattern);
          const globPart = path.basename(expandedPattern);
          const files = await this.globFiles(dir, globPart);

          for (const file of files) {
            try {
              const included = await fs.promises.readFile(file, 'utf8');
              result.push(included);
            } catch {
              // Skip unreadable included files
            }
          }
        } else {
          const included = await fs.promises.readFile(expandedPattern, 'utf8');
          result.push(included);
        }
      } catch {
        // Skip unresolvable includes
      }
    }

    return result.join('\n');
  }

  private async globFiles(dir: string, pattern: string): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(dir);
      const regex = new RegExp(
        '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
      );
      return entries.filter((e) => regex.test(e)).map((e) => path.join(dir, e));
    } catch {
      return [];
    }
  }
}
