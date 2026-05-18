import fs from 'node:fs/promises';
import path from 'node:path';

import {
  collectWorkspaceTrustParentConfigKeys,
  normalizeWorkspaceTrustConfigKey,
  type WorkspaceTrustPathPlatform,
} from '../../../core/domain';

import type { ProviderStateProbe, ProviderTrustState } from '../../../core/application';
import type { WorkspaceTrustWorkspace } from '../../../core/domain';

const DEFAULT_MAX_CONFIG_BYTES = 1024 * 1024;
const DEFAULT_READ_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasTrustDialogAccepted(value: unknown): boolean {
  return isRecord(value) && value.hasTrustDialogAccepted === true;
}

export class FileClaudeStateProbe implements ProviderStateProbe {
  constructor(
    private readonly options: {
      claudeConfigDir?: string;
      globalConfigFilePath?: string | (() => string);
      platform?: WorkspaceTrustPathPlatform;
      maxConfigBytes?: number;
      readAttempts?: number;
      retryDelayMs?: number;
    }
  ) {}

  async readTrustState(workspace: WorkspaceTrustWorkspace): Promise<ProviderTrustState> {
    const configPath =
      (typeof this.options.globalConfigFilePath === 'function'
        ? this.options.globalConfigFilePath()
        : this.options.globalConfigFilePath) ??
      path.join(this.options.claudeConfigDir ?? process.cwd(), '.claude.json');
    const attempts = this.options.readAttempts ?? DEFAULT_READ_ATTEMPTS;
    const retryDelayMs = this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const stat = await fs.stat(configPath);
        if (stat.size > (this.options.maxConfigBytes ?? DEFAULT_MAX_CONFIG_BYTES)) {
          return {
            status: 'unknown',
            errorMessage: `Claude state file exceeds ${this.options.maxConfigBytes ?? DEFAULT_MAX_CONFIG_BYTES} bytes.`,
          };
        }

        const raw = await fs.readFile(configPath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (!isRecord(parsed) || !isRecord(parsed.projects)) {
          return { status: 'untrusted', evidence: ['claude state has no projects map'] };
        }

        for (const key of this.buildCandidateConfigKeys(workspace)) {
          if (hasTrustDialogAccepted(parsed.projects[key])) {
            return { status: 'trusted', evidence: [`trusted project key: ${key}`] };
          }
        }
        return { status: 'untrusted', evidence: ['no trusted project key matched'] };
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return { status: 'untrusted', evidence: ['claude state file missing'] };
        }
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < attempts) {
          await sleep(retryDelayMs);
        }
      }
    }

    return {
      status: 'unknown',
      errorMessage: lastError ?? 'Claude state file could not be read.',
    };
  }

  private buildCandidateConfigKeys(workspace: WorkspaceTrustWorkspace): string[] {
    const keys = new Set<string>();
    const platform = this.options.platform;
    const addParents = (value: string | undefined): void => {
      if (!value) {
        return;
      }
      for (const key of collectWorkspaceTrustParentConfigKeys(value, { platform })) {
        keys.add(key);
      }
    };

    addParents(workspace.cwd);
    addParents(workspace.realCwd);
    addParents(workspace.configKeyCwd);
    if (workspace.gitRootConfigKey) {
      keys.add(normalizeWorkspaceTrustConfigKey(workspace.gitRootConfigKey, { platform }));
      addParents(workspace.gitRootConfigKey);
    }
    return [...keys];
  }
}
