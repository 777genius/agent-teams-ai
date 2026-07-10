import {
  killTmuxPaneForCurrentPlatformSync,
  listTmuxPanePidsForCurrentPlatform,
  listTmuxPaneRuntimeInfoForCurrentPlatform,
} from '@features/tmux-installer/main';
import { isProcessAlive } from '@main/utils/processHealth';
import { killProcessByPid } from '@main/utils/processKill';
import { createLogger } from '@shared/utils/logger';

import { isInteractiveShellCommand } from './TeamProvisioningDirectRestart';
import { matchesMemberNameOrBase } from './TeamProvisioningMemberIdentity';

const logger = createLogger('Service:TeamProvisioning');

export interface PrimaryOwnedMemberRestartPersistedRuntimeMember {
  name?: string;
  tmuxPaneId?: string;
  backendType?: string;
}

export interface PrimaryOwnedMemberRestartLiveRuntimeMetadata {
  alive?: boolean;
  backendType?: string;
  pid?: number;
}

export interface PreparePrimaryOwnedMemberRestartRuntimeInput {
  teamName: string;
  memberName: string;
  persistedRuntimeMembers: readonly PrimaryOwnedMemberRestartPersistedRuntimeMember[];
  assertStillCurrent?(): void;
  invalidateRuntimeSnapshotCaches(): void;
  loadLiveRuntimeByMember(): Promise<
    ReadonlyMap<string, PrimaryOwnedMemberRestartLiveRuntimeMetadata>
  >;
}

export interface PreparePrimaryOwnedMemberRestartRuntimeResult {
  directTmuxRestartPaneId: string | null;
  shouldDirectProcessRestart: boolean;
}

export interface PreparePrimaryOwnedMemberRestartRuntimeUseCasePorts {
  listTmuxPaneRuntimeInfo(
    paneIds: readonly string[]
  ): Promise<Map<string, { currentCommand?: string }>>;
  killTmuxPane(paneId: string): void;
  killProcess(pid: number): void;
  waitForPidsToExit(
    pids: readonly number[],
    options: { timeoutMs: number; pollMs: number }
  ): Promise<number[]>;
  waitForTmuxPanesToExit(
    paneIds: readonly string[],
    options: { timeoutMs: number; pollMs: number }
  ): Promise<string[]>;
  logInfo(message: string): void;
  logDebug(message: string): void;
}

export type PreparePrimaryOwnedMemberRestartRuntimeUseCase = (
  input: PreparePrimaryOwnedMemberRestartRuntimeInput
) => Promise<PreparePrimaryOwnedMemberRestartRuntimeResult>;

export function createNodePreparePrimaryOwnedMemberRestartRuntimeUseCase(): PreparePrimaryOwnedMemberRestartRuntimeUseCase {
  return createPreparePrimaryOwnedMemberRestartRuntimeUseCase({
    listTmuxPaneRuntimeInfo: (paneIds) => listTmuxPaneRuntimeInfoForCurrentPlatform(paneIds),
    killTmuxPane: (paneId) => killTmuxPaneForCurrentPlatformSync(paneId),
    killProcess: (pid) => killProcessByPid(pid),
    waitForPidsToExit,
    waitForTmuxPanesToExit,
    logInfo: (message) => logger.info(message),
    logDebug: (message) => logger.debug(message),
  });
}

export function createPreparePrimaryOwnedMemberRestartRuntimeUseCase(
  ports: PreparePrimaryOwnedMemberRestartRuntimeUseCasePorts
): PreparePrimaryOwnedMemberRestartRuntimeUseCase {
  return async (input) => {
    const backendTypes = new Set(
      input.persistedRuntimeMembers
        .map((member) => member.backendType?.trim().toLowerCase())
        .filter((value): value is string => Boolean(value))
    );
    if (backendTypes.has('in-process')) {
      throw new Error(
        `Member "${input.memberName}" uses an in-process runtime and cannot be restarted here`
      );
    }

    input.assertStillCurrent?.();
    input.invalidateRuntimeSnapshotCaches();
    const liveRuntimeByMember = await input.loadLiveRuntimeByMember();
    input.assertStillCurrent?.();

    const livePids = new Set<number>();
    let hasAliveRuntimeWithoutPid = false;
    for (const [candidateName, metadata] of liveRuntimeByMember.entries()) {
      if (!matchesMemberNameOrBase(candidateName, input.memberName)) {
        continue;
      }
      if (metadata.pid) {
        livePids.add(metadata.pid);
        continue;
      }
      if (metadata.alive && metadata.backendType !== 'in-process') {
        hasAliveRuntimeWithoutPid = true;
      }
    }

    if (hasAliveRuntimeWithoutPid) {
      throw new Error(
        `Member "${input.memberName}" is running, but its backend does not expose a restartable pid yet`
      );
    }

    let directTmuxRestartPaneId: string | null = null;
    const directTmuxRestartCandidatePaneId = getDirectTmuxRestartPaneId(
      input.persistedRuntimeMembers,
      input.memberName
    );
    if (directTmuxRestartCandidatePaneId) {
      try {
        const paneInfo = (
          await ports.listTmuxPaneRuntimeInfo([directTmuxRestartCandidatePaneId])
        ).get(directTmuxRestartCandidatePaneId);
        if (paneInfo && isInteractiveShellCommand(paneInfo.currentCommand)) {
          directTmuxRestartPaneId = directTmuxRestartCandidatePaneId;
        }
      } catch (error) {
        ports.logDebug(
          `[${input.teamName}] Direct tmux restart probe failed for ${input.memberName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    input.assertStillCurrent?.();

    const tmuxPaneIdsToVerify: string[] = [];
    if (!directTmuxRestartPaneId) {
      for (const persistedRuntimeMember of input.persistedRuntimeMembers) {
        const paneId =
          typeof persistedRuntimeMember.tmuxPaneId === 'string'
            ? persistedRuntimeMember.tmuxPaneId.trim()
            : '';
        const backendType = persistedRuntimeMember.backendType?.trim().toLowerCase();
        if (!paneId || backendType !== 'tmux') {
          continue;
        }
        tmuxPaneIdsToVerify.push(paneId);
        try {
          ports.killTmuxPane(paneId);
          ports.logInfo(
            `[${input.teamName}] Killed teammate pane ${input.memberName} (${paneId}) for manual restart`
          );
        } catch (error) {
          ports.logDebug(
            `[${input.teamName}] Failed to kill teammate pane ${input.memberName} (${paneId}) for manual restart: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }

    for (const pid of livePids) {
      try {
        ports.killProcess(pid);
      } catch (error) {
        ports.logDebug(
          `[${input.teamName}] Failed to kill teammate process ${input.memberName} pid=${pid} for manual restart: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    if (livePids.size > 0) {
      const lingeringPids = await ports.waitForPidsToExit([...livePids], {
        timeoutMs: 1_500,
        pollMs: 100,
      });
      if (lingeringPids.length > 0) {
        throw new Error(
          `Restart for teammate "${input.memberName}" is still waiting for the previous process to exit (${lingeringPids.join(', ')}).`
        );
      }
    }

    if (tmuxPaneIdsToVerify.length > 0) {
      let lingeringPaneIds: string[];
      try {
        lingeringPaneIds = await ports.waitForTmuxPanesToExit(tmuxPaneIdsToVerify, {
          timeoutMs: 1_500,
          pollMs: 100,
        });
      } catch (error) {
        throw new Error(
          `Restart for teammate "${input.memberName}" could not verify that the previous tmux pane exited: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      if (lingeringPaneIds.length > 0) {
        throw new Error(
          `Restart for teammate "${input.memberName}" is still waiting for the previous tmux pane to exit (${lingeringPaneIds.join(', ')}).`
        );
      }
    }

    return {
      directTmuxRestartPaneId,
      shouldDirectProcessRestart: backendTypes.has('process') || livePids.size > 0,
    };
  };
}

function getDirectTmuxRestartPaneId(
  persistedRuntimeMembers: readonly PrimaryOwnedMemberRestartPersistedRuntimeMember[],
  memberName: string
): string | null {
  for (const persistedRuntimeMember of persistedRuntimeMembers) {
    const backendType = persistedRuntimeMember.backendType?.trim().toLowerCase();
    const paneId =
      typeof persistedRuntimeMember.tmuxPaneId === 'string'
        ? persistedRuntimeMember.tmuxPaneId.trim()
        : '';
    const runtimeMemberName =
      typeof persistedRuntimeMember.name === 'string' ? persistedRuntimeMember.name : '';
    if (
      backendType === 'tmux' &&
      paneId &&
      matchesMemberNameOrBase(runtimeMemberName, memberName)
    ) {
      return paneId;
    }
  }
  return null;
}

async function waitForPidsToExit(
  pids: readonly number[],
  options: { timeoutMs: number; pollMs: number }
): Promise<number[]> {
  const uniquePids = [...new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0))];
  if (uniquePids.length === 0) {
    return [];
  }
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const alive = uniquePids.filter((pid) => isProcessAlive(pid));
    if (alive.length === 0) {
      return [];
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
  return uniquePids.filter((pid) => isProcessAlive(pid));
}

async function waitForTmuxPanesToExit(
  paneIds: readonly string[],
  options: { timeoutMs: number; pollMs: number }
): Promise<string[]> {
  const uniquePaneIds = [...new Set(paneIds.map((paneId) => paneId.trim()).filter(Boolean))];
  if (uniquePaneIds.length === 0) {
    return [];
  }
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    let paneInfo: Map<string, number>;
    try {
      paneInfo = await listTmuxPanePidsForCurrentPlatform(uniquePaneIds);
    } catch (error) {
      if (isTmuxServerUnavailableError(error)) {
        return [];
      }
      throw error;
    }
    const alive = uniquePaneIds.filter((paneId) => paneInfo.has(paneId));
    if (alive.length === 0) {
      return [];
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
  let finalPaneInfo: Map<string, number>;
  try {
    finalPaneInfo = await listTmuxPanePidsForCurrentPlatform(uniquePaneIds);
  } catch (error) {
    if (isTmuxServerUnavailableError(error)) {
      return [];
    }
    throw error;
  }
  return uniquePaneIds.filter((paneId) => finalPaneInfo.has(paneId));
}

function isTmuxServerUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /error connecting to .*tmux.*No such file or directory/i.test(message);
}
