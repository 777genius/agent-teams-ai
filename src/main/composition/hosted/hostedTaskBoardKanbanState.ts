// eslint-disable-next-line no-restricted-imports -- Board identities use the feature public contract.
import {
  type HostedTaskBoardSourceGeneration,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskId,
  type TaskId,
} from '@features/team-task-board/main/hosted';
import { parseRevision, type Revision } from '@shared/contracts/hosted';
import * as agentTeamsControllerModule from 'agent-teams-controller';

import type { HostedTaskBoardDirectoryDescriptor } from './hostedTaskBoardDescriptorFs';

const {
  hostedBoardDigest: digest,
  hostedTaskBoardRevision,
  hostedTaskBoardSourceGeneration: controllerHostedTaskBoardSourceGeneration,
  hostedTaskBoardTaskId: controllerHostedTaskBoardTaskId,
} = agentTeamsControllerModule.hostedBoardIdentity;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseHostedTaskBoardKanbanRecord(serialized: string | null): JsonRecord {
  if (serialized === null) return {};
  const value: unknown = JSON.parse(serialized);
  if (
    !isRecord(value) ||
    (value.version !== undefined && value.version !== 1) ||
    (value.tasks !== undefined && !isRecord(value.tasks)) ||
    (value.columnOrder !== undefined && !isRecord(value.columnOrder)) ||
    (value.reviewers !== undefined && !Array.isArray(value.reviewers)) ||
    (value.teamName !== undefined && typeof value.teamName !== 'string')
  ) {
    throw new TypeError('hosted-task-board-kanban-invalid');
  }
  return value;
}

export function hostedTaskBoardDirectoryFingerprint(input: {
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
}): string {
  return digest({
    schemaVersion: 1,
    canonicalPath: input.canonicalPath,
    device: input.device.toString(),
    inode: input.inode.toString(),
  });
}

export function hostedTaskBoardTaskId(teamId: string, rawTaskId: string): TaskId {
  return parseHostedTaskId(controllerHostedTaskBoardTaskId(teamId, rawTaskId));
}

export function hostedTaskBoardSourceGeneration(input: {
  readonly deploymentId: string;
  readonly bootId: string;
  readonly workspaceId: string;
  readonly mountGeneration: number;
  readonly teamId: string;
  readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
}): HostedTaskBoardSourceGeneration {
  return parseHostedTaskBoardSourceGeneration(
    controllerHostedTaskBoardSourceGeneration({
      deploymentId: input.deploymentId,
      bootId: input.bootId,
      workspaceId: input.workspaceId,
      mountGeneration: input.mountGeneration,
      teamId: input.teamId,
      teamDirectory: [
        input.teamDirectory.identity.device.toString(),
        input.teamDirectory.identity.inode.toString(),
      ],
      tasksDirectory: [
        input.tasksDirectory.identity.device.toString(),
        input.tasksDirectory.identity.inode.toString(),
      ],
    })
  );
}

export function hostedTaskBoardRevisionForContents(input: {
  readonly sourceGeneration: HostedTaskBoardSourceGeneration;
  readonly taskFiles: readonly { readonly name: string; readonly text: string | null }[];
  readonly kanbanText: string | null;
  readonly rosterFiles?: readonly { readonly name: string; readonly text: string | null }[];
}): Revision {
  if (input.taskFiles.some((task) => task.text === null)) {
    throw new TypeError('hosted-task-board-revision-input-invalid');
  }
  return parseRevision(
    hostedTaskBoardRevision({
      sourceGeneration: input.sourceGeneration,
      taskFiles: input.taskFiles as readonly { readonly name: string; readonly text: string }[],
      kanbanText: input.kanbanText,
      rosterFiles: input.rosterFiles ?? [],
    })
  );
}
