import { getClaudeBasePath } from '@main/utils/pathDecoder';
import * as agentTeamsControllerModule from 'agent-teams-controller';

import type { TeamMessagePersistenceFacade } from '@features/team-message-delivery/main';
import type { TeamArtifactMaintenanceReconciliationRequest } from '@features/team-task-board';
import type { TaskMutationBoardPort, TeamTaskStartBoardPort } from '@features/team-task-board/main';
import type { TeamProcess } from '@shared/types';

const { createController } = agentTeamsControllerModule;

export type TeamDataTaskBoardPort = TaskMutationBoardPort & TeamTaskStartBoardPort;

type TeamMessagePersistenceResult = Awaited<
  ReturnType<TeamMessagePersistenceFacade['sendMessage']>
>;

interface LegacyTaskBoardController {
  readonly taskBoard?: TeamDataTaskBoardPort;
  readonly tasks?: Partial<TeamDataTaskBoardPort>;
  readonly kanban?: Partial<TeamDataTaskBoardPort>;
  readonly review?: Partial<TeamDataTaskBoardPort>;
}

/**
 * The exact external-controller shape consumed by this compatibility seam.
 * It intentionally excludes runtime and cross-team APIs.
 */
interface TeamDataControllerCapabilitySource extends LegacyTaskBoardController {
  readonly processes: {
    listProcesses(): unknown[];
    stopProcess(request: { pid: number }): unknown;
  };
  readonly messages: {
    sendMessage(request: Record<string, unknown>): unknown;
    appendSentMessage(request: Record<string, unknown>): unknown;
  };
  readonly maintenance: {
    reconcileArtifacts(request: { reason: string }): unknown;
  };
}

export type TeamDataControllerFactory = (teamName: string) => TeamDataControllerCapabilitySource;

export interface TeamDataTaskBoardCapability {
  getTaskBoard(teamName: string): TeamDataTaskBoardPort | null;
}

export interface TeamDataProcessCapability {
  listProcesses(teamName: string): TeamProcess[];
  stopProcess(teamName: string, pid: number): void;
}

export interface TeamDataMessagePersistenceCapability {
  sendMessage(teamName: string, request: Record<string, unknown>): TeamMessagePersistenceResult;
  appendSentMessage(teamName: string, request: Record<string, unknown>): { messageId?: string };
}

export interface TeamDataArtifactMaintenanceCapability {
  reconcileArtifacts(
    teamName: string,
    request: TeamArtifactMaintenanceReconciliationRequest
  ): unknown;
}

export interface TeamDataControllerCompatibilityCapabilities {
  readonly taskBoard: TeamDataTaskBoardCapability;
  readonly processes: TeamDataProcessCapability;
  readonly messagePersistence: TeamDataMessagePersistenceCapability;
  readonly artifactMaintenance: TeamDataArtifactMaintenanceCapability;
}

/**
 * The outer compatibility seam for the legacy controller package.
 *
 * It deliberately exposes only the controller conversations retained by
 * TeamDataService; provisioning and runtime lifecycle ownership stay elsewhere.
 */
export class TeamDataControllerCompatibilityAdapter implements TeamDataControllerCompatibilityCapabilities {
  readonly taskBoard: TeamDataTaskBoardCapability;
  readonly processes: TeamDataProcessCapability;
  readonly messagePersistence: TeamDataMessagePersistenceCapability;
  readonly artifactMaintenance: TeamDataArtifactMaintenanceCapability;

  constructor(
    private readonly controllerFactory: TeamDataControllerFactory = (teamName) =>
      createController({
        teamName,
        claudeDir: getClaudeBasePath(),
      }) as unknown as TeamDataControllerCapabilitySource
  ) {
    this.taskBoard = {
      getTaskBoard: (teamName) => this.getTaskBoard(teamName),
    };
    this.processes = {
      listProcesses: (teamName) => this.listProcesses(teamName),
      stopProcess: (teamName, pid) => this.stopProcess(teamName, pid),
    };
    this.messagePersistence = {
      sendMessage: (teamName, request) => this.sendMessage(teamName, request),
      appendSentMessage: (teamName, request) => this.appendSentMessage(teamName, request),
    };
    this.artifactMaintenance = {
      reconcileArtifacts: (teamName, request) => this.reconcileArtifacts(teamName, request),
    };
  }

  private resolveCapabilitySource(teamName: string): TeamDataControllerCapabilitySource {
    return this.controllerFactory(teamName);
  }

  private getTaskBoard(teamName: string): TeamDataTaskBoardPort | null {
    const controller = this.resolveCapabilitySource(teamName);
    return controller.taskBoard ?? this.buildLegacyTaskBoard(controller);
  }

  private listProcesses(teamName: string): TeamProcess[] {
    return this.resolveCapabilitySource(teamName).processes.listProcesses() as TeamProcess[];
  }

  private stopProcess(teamName: string, pid: number): void {
    this.resolveCapabilitySource(teamName).processes.stopProcess({ pid });
  }

  private sendMessage(
    teamName: string,
    request: Record<string, unknown>
  ): TeamMessagePersistenceResult {
    return this.resolveCapabilitySource(teamName).messages.sendMessage(
      request
    ) as TeamMessagePersistenceResult;
  }

  private appendSentMessage(
    teamName: string,
    request: Record<string, unknown>
  ): { messageId?: string } {
    return this.resolveCapabilitySource(teamName).messages.appendSentMessage(request) as {
      messageId?: string;
    };
  }

  private reconcileArtifacts(
    teamName: string,
    request: TeamArtifactMaintenanceReconciliationRequest
  ): unknown {
    return this.resolveCapabilitySource(teamName).maintenance.reconcileArtifacts({
      reason: request.reason,
    });
  }

  private buildLegacyTaskBoard(
    controller: LegacyTaskBoardController
  ): TeamDataTaskBoardPort | null {
    if (!controller.tasks && !controller.kanban && !controller.review) {
      return null;
    }
    return {
      ...(controller.tasks ?? {}),
      ...(controller.kanban ?? {}),
      ...(controller.review ?? {}),
    } as TeamDataTaskBoardPort;
  }
}
