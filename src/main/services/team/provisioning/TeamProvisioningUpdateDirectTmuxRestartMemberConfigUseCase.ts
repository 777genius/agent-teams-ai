import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from '../atomicWrite';
import { withFileLock } from '../fileLock';
import { TeamConfigReader } from '../TeamConfigReader';
import { getTeamDataWorkerClient } from '../TeamDataWorkerClient';

import { matchesExactTeamMemberName } from './TeamProvisioningMemberIdentity';

import type { TeamConfig, TeamCreateRequest, TeamProviderId } from '@shared/types';

const TEAM_JSON_READ_TIMEOUT_MS = 5_000;
const TEAM_CONFIG_MAX_BYTES = 10 * 1024 * 1024;
const PROCESS_BACKEND_OPTIONAL_METADATA_FIELDS = [
  'runtimePid',
  'runtimeSessionId',
  'bootstrapRuntimeEventsPath',
  'bootstrapProofToken',
  'bootstrapRunId',
  'bootstrapProofMode',
  'bootstrapContextHash',
  'bootstrapBriefingHash',
] as const;

export interface DirectTmuxRestartMemberConfigInput {
  teamName: string;
  memberName: string;
  member: TeamCreateRequest['members'][number] & { agentType?: string };
  agentId: string;
  color: string;
  prompt: string;
  paneId: string;
  cwd: string;
  providerId: TeamProviderId;
  joinedAt: number;
  bootstrapExpectedAfter: string;
  backendType?: 'tmux' | 'process';
  runtimePid?: number;
  bootstrapRuntimeEventsPath?: string;
  bootstrapProofToken?: string;
  bootstrapRunId?: string;
  bootstrapContextHash?: string;
  bootstrapBriefingHash?: string;
  assertStillCurrent?: () => void;
}

export type UpdateDirectTmuxRestartMemberConfigUseCase = (
  input: DirectTmuxRestartMemberConfigInput
) => Promise<void>;

export interface UpdateDirectTmuxRestartMemberConfigUseCasePorts {
  readTeamConfigJson(teamName: string): Promise<string | null>;
  writeTeamConfigJson(teamName: string, contents: string): Promise<void>;
  invalidateTeamConfig(teamName: string): void;
  withTeamConfigLock?<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
}

const teamConfigMutationQueues = new Map<string, Promise<void>>();

async function withInProcessTeamConfigMutationLock<T>(
  teamName: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = teamConfigMutationQueues.get(teamName) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  teamConfigMutationQueues.set(teamName, current);
  // Keep queue admission rejection-safe if a prior or legacy tail rejects.
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (teamConfigMutationQueues.get(teamName) === current) {
      teamConfigMutationQueues.delete(teamName);
    }
  }
}

async function tryReadRegularFileUtf8(
  filePath: string,
  opts: { timeoutMs: number; maxBytes: number }
): Promise<string | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return null;
  }

  if (!stat.isFile() || stat.size > opts.maxBytes) {
    return null;
  }

  try {
    return await readFileUtf8WithTimeout(filePath, opts.timeoutMs);
  } catch (error) {
    if (error instanceof FileReadTimeoutError) {
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function createUpdateDirectTmuxRestartMemberConfigUseCase(
  ports: UpdateDirectTmuxRestartMemberConfigUseCasePorts
): UpdateDirectTmuxRestartMemberConfigUseCase {
  const update: UpdateDirectTmuxRestartMemberConfigUseCase = async (input) => {
    const raw = await ports.readTeamConfigJson(input.teamName);
    if (!raw) {
      throw new Error(`Team "${input.teamName}" configuration is no longer available`);
    }

    let parsed: TeamConfig & { members?: Record<string, unknown>[] };
    try {
      parsed = JSON.parse(raw) as TeamConfig & { members?: Record<string, unknown>[] };
    } catch (error) {
      // config.json can be written concurrently by the runtime CLI (outside our
      // config-mutation lock), so a read can observe a torn/partial file. Treat a
      // corrupt read as a transient restart failure with a clear message instead
      // of surfacing a raw SyntaxError.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Team "${input.teamName}" configuration is currently unreadable (possibly mid-write by the runtime CLI): ${message}`
      );
    }
    const members = Array.isArray(parsed.members) ? parsed.members : [];
    const existingIndex = members.findIndex((member) => {
      const candidateName = typeof member?.name === 'string' ? member.name.trim() : '';
      return (
        candidateName.length > 0 && matchesExactTeamMemberName(candidateName, input.memberName)
      );
    });
    const existing: Record<string, unknown> =
      existingIndex >= 0 ? (members[existingIndex] ?? {}) : {};
    const backendType = input.backendType ?? 'tmux';
    const existingForRestart = { ...existing };
    if (existing.backendType === 'process') {
      for (const field of PROCESS_BACKEND_OPTIONAL_METADATA_FIELDS) {
        delete existingForRestart[field];
      }
    }
    const nextMember = {
      ...existingForRestart,
      agentId: input.agentId,
      name: input.member.name,
      ...(input.member.role ? { role: input.member.role } : {}),
      ...(input.member.workflow ? { workflow: input.member.workflow } : {}),
      ...(input.member.agentType ? { agentType: input.member.agentType } : {}),
      provider: input.providerId,
      providerId: input.providerId,
      ...(input.member.model ? { model: input.member.model } : {}),
      ...(input.member.effort ? { effort: input.member.effort } : {}),
      prompt: input.prompt,
      color: input.color,
      joinedAt: input.joinedAt,
      bootstrapExpectedAfter: input.bootstrapExpectedAfter,
      ...(input.bootstrapProofToken ? { bootstrapProofToken: input.bootstrapProofToken } : {}),
      ...(input.bootstrapRunId ? { bootstrapRunId: input.bootstrapRunId } : {}),
      ...(input.bootstrapRuntimeEventsPath
        ? { bootstrapRuntimeEventsPath: input.bootstrapRuntimeEventsPath }
        : {}),
      ...(input.bootstrapContextHash
        ? {
            bootstrapProofMode: 'native_app_managed_context',
            bootstrapContextHash: input.bootstrapContextHash,
          }
        : {}),
      ...(input.bootstrapBriefingHash
        ? { bootstrapBriefingHash: input.bootstrapBriefingHash }
        : {}),
      tmuxPaneId: input.paneId,
      ...(typeof input.runtimePid === 'number' ? { runtimePid: input.runtimePid } : {}),
      cwd: input.cwd,
      subscriptions: Array.isArray(existing.subscriptions) ? existing.subscriptions : [],
      backendType,
    };

    if (existingIndex >= 0) {
      members[existingIndex] = nextMember;
    } else {
      members.push(nextMember);
    }
    parsed.members = members;
    input.assertStillCurrent?.();
    await ports.writeTeamConfigJson(input.teamName, `${JSON.stringify(parsed, null, 2)}\n`);
    ports.invalidateTeamConfig(input.teamName);
  };

  return async (input) => {
    await withInProcessTeamConfigMutationLock(input.teamName, async () => {
      if (ports.withTeamConfigLock) {
        await ports.withTeamConfigLock(input.teamName, () => update(input));
        return;
      }
      await update(input);
    });
  };
}

export function createNodeUpdateDirectTmuxRestartMemberConfigUseCasePorts(): UpdateDirectTmuxRestartMemberConfigUseCasePorts {
  return {
    async readTeamConfigJson(teamName) {
      const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
      return tryReadRegularFileUtf8(configPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
    },
    async writeTeamConfigJson(teamName, contents) {
      const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
      await atomicWriteAsync(configPath, contents);
    },
    withTeamConfigLock(teamName, operation) {
      const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
      return withFileLock(configPath, operation);
    },
    invalidateTeamConfig(teamName) {
      TeamConfigReader.invalidateTeam(teamName);
      getTeamDataWorkerClient().invalidateTeamConfig(teamName);
    },
  };
}

export function createNodeUpdateDirectTmuxRestartMemberConfigUseCase(): UpdateDirectTmuxRestartMemberConfigUseCase {
  return createUpdateDirectTmuxRestartMemberConfigUseCase(
    createNodeUpdateDirectTmuxRestartMemberConfigUseCasePorts()
  );
}
