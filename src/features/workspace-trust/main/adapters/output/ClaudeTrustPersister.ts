import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';

import {
  getWorkspaceTrustNonPersistableReason,
  normalizeWorkspaceTrustConfigKey,
  type WorkspaceTrustPathPlatform,
} from '../../../core/domain';

import type { ProviderTrustPersister, ProviderTrustPersistResult } from '../../../core/application';
import type { WorkspaceTrustWorkspace } from '../../../core/domain';

const DEFAULT_MAX_CONFIG_BYTES = 1024 * 1024;
const writeLocks = new Map<string, Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function withWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  writeLocks.set(key, chained);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (writeLocks.get(key) === chained) {
      writeLocks.delete(key);
    }
  }
}

function getConfigPath(options: {
  claudeConfigDir?: string;
  globalConfigFilePath?: string | (() => string);
}): string {
  return (
    (typeof options.globalConfigFilePath === 'function'
      ? options.globalConfigFilePath()
      : options.globalConfigFilePath) ??
    path.join(options.claudeConfigDir ?? process.cwd(), '.claude.json')
  );
}

function buildExactTrustKeys(
  workspace: WorkspaceTrustWorkspace,
  platform?: WorkspaceTrustPathPlatform,
  homeDir?: string | null
): string[] {
  const keys = new Set<string>();
  const add = (value: string | undefined): void => {
    if (!value) {
      return;
    }
    const key = normalizeWorkspaceTrustConfigKey(value, { platform });
    if (key) {
      if (getWorkspaceTrustNonPersistableReason(key, { platform, homeDir })) {
        return;
      }
      keys.add(key);
    }
  };

  add(workspace.configKeyCwd);
  add(workspace.cwd);
  add(workspace.realCwd);
  add(workspace.gitRootConfigKey);
  return [...keys];
}

export class FileClaudeTrustPersister implements ProviderTrustPersister {
  constructor(
    private readonly options: {
      claudeConfigDir?: string;
      globalConfigFilePath?: string | (() => string);
      platform?: WorkspaceTrustPathPlatform;
      homeDir?: string | null;
      maxConfigBytes?: number;
    }
  ) {}

  async persistTrustState(workspace: WorkspaceTrustWorkspace): Promise<ProviderTrustPersistResult> {
    if (!workspace.persistable) {
      return {
        ok: false,
        code: `workspace_trust_not_persistable_${workspace.nonPersistableReason ?? 'unknown'}`,
        message: `Workspace trust cannot be persisted for ${workspace.configKeyCwd}.`,
      };
    }

    const configPath = getConfigPath(this.options);
    return withWriteLock(configPath, async () =>
      this.persistTrustStateUnlocked(configPath, workspace)
    );
  }

  private async persistTrustStateUnlocked(
    configPath: string,
    workspace: WorkspaceTrustWorkspace
  ): Promise<ProviderTrustPersistResult> {
    const maxConfigBytes = this.options.maxConfigBytes ?? DEFAULT_MAX_CONFIG_BYTES;
    let parsed: Record<string, unknown>;

    try {
      const stat = await fs.stat(configPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return null;
        }
        throw error;
      });
      if (stat && stat.size > maxConfigBytes) {
        return {
          ok: false,
          code: 'claude_state_too_large',
          message: `Claude state file exceeds ${maxConfigBytes} bytes.`,
        };
      }

      if (stat) {
        const raw = await fs.readFile(configPath, 'utf8');
        const value = JSON.parse(raw) as unknown;
        if (!isRecord(value)) {
          return {
            ok: false,
            code: 'claude_state_invalid_shape',
            message: 'Claude state file is not a JSON object.',
          };
        }
        parsed = value;
      } else {
        parsed = {};
      }
    } catch (error) {
      return {
        ok: false,
        code: 'claude_state_read_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (parsed.projects !== undefined && !isRecord(parsed.projects)) {
      return {
        ok: false,
        code: 'claude_state_projects_invalid_shape',
        message: 'Claude state projects field is not a JSON object.',
      };
    }

    const projects = isRecord(parsed.projects) ? { ...parsed.projects } : {};
    const keys = buildExactTrustKeys(
      workspace,
      this.options.platform,
      this.options.homeDir ?? os.homedir()
    );
    if (keys.length === 0) {
      return {
        ok: false,
        code: 'workspace_trust_no_config_keys',
        message: `No Claude trust config keys were derived for ${workspace.displayCwd}.`,
      };
    }

    for (const key of keys) {
      const existing = projects[key];
      projects[key] = {
        ...(isRecord(existing) ? existing : {}),
        hasTrustDialogAccepted: true,
      };
    }

    try {
      await atomicWriteAsync(configPath, `${JSON.stringify({ ...parsed, projects }, null, 2)}\n`);
    } catch (error) {
      return {
        ok: false,
        code: 'claude_state_write_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      ok: true,
      evidence: keys.map((key) => `persisted trusted project key: ${key}`),
    };
  }
}
