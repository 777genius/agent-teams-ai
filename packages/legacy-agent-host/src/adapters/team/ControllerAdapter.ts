import { readGroupFile, writeGroupFile } from './groupStorageFiles.js';
import { assertValidGroupInboxRows } from '../../group-chats/envelope.js';
import { safeSegment } from '../../team/identity.js';
import { createControllerProcessPolicy } from '../../process/ControllerProcessPolicy.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { startTaskNotifying } from './TaskStartNotifier.js';

import type { JsonValue } from '../../contracts.js';
import type { TaskBoardPolicy, TeamBoardReadPolicy, TeamPolicyPort } from '../../team/ports.js';

const require = createRequire(import.meta.url);

interface Controller {
  context: { paths: Record<string, string> };
  taskBoard: Omit<TaskBoardPolicy, 'startTaskNotifying'> &
    TeamBoardReadPolicy & {
      memberBriefing(
        member: string,
        options: {
          includeActiveProcesses: boolean;
          boundTeamToolExample: true;
          allowRuntimeIdentityFallback: false;
        }
      ): Promise<string>;
    };
  messages: {
    sendMessage(flags: Record<string, unknown>): {
      messageId: string;
      message: JsonValue;
    };
    appendSentMessage(flags: Record<string, unknown>): JsonValue;
  };
}

/** Existing portable JS policy; no Electron, fork executable, or replacement Task handler. */
export function createTeamController(
  root: string,
  teamName: string,
  allowUserMessageSender = false
): Controller {
  const api = require('agent-teams-controller') as {
    createController(options: {
      claudeDir: string;
      teamName: string;
      allowUserMessageSender: boolean;
      boundTaskTools: boolean;
    }): Controller;
  };
  return api.createController({
    claudeDir: root,
    teamName,
    allowUserMessageSender,
    boundTaskTools: true,
  });
}

// These existing IO primitives retain the controller's filesystem lock protocol.
// Kept at this adapter boundary; Team policy never imports package internals.
const lock = require('agent-teams-controller/src/internal/fileLock.js') as {
  withFileLockSync<T>(scope: string, action: () => T, options?: { createParent?: boolean }): T;
};
const atomic = require('agent-teams-controller/src/internal/atomicFile.js') as {
  writeJsonFileSync(filePath: string, value: unknown): void;
};
const boardLock = require('agent-teams-controller/src/internal/boardLock.js') as {
  withTeamBoardLock<T>(paths: { teamDir: string }, action: () => T): T;
};

const messageStore = require('agent-teams-controller/src/internal/messageStore.js') as {
  sendInboxMessage(
    paths: Record<string, string>,
    flags: Record<string, unknown>
  ): { messageId: string; message: JsonValue };
};

export const withTeamFileFence = lock.withFileLockSync;
export const writeTeamJson = atomic.writeJsonFileSync;

export function createTeamPolicy(root: string, teamName: string): TeamPolicyPort {
  // Query policy uses the same captured root and board lock as product reads.
  const boardRead = <T>(action: (board: Controller['taskBoard']) => T): T =>
    boardLock.withTeamBoardLock({ teamDir: join(root, 'teams', teamName) }, () =>
      action(createTeamController(root, teamName).taskBoard)
    );
  return {
    reads: {
      getTaskComment: (taskId, commentId) =>
        boardRead((board) => board.getTaskComment(taskId, commentId)),
      listTaskInventory: (filters) => boardRead((board) => board.listTaskInventory(filters)),
      taskBriefing: (member) => boardRead((board) => board.taskBriefing(member)),
      leadBriefing: () => boardRead((board) => board.leadBriefing()),
      memberBriefing: (member, options) =>
        boardRead((board) =>
          board.memberBriefing(member, {
            ...options,
            boundTeamToolExample: true,
            allowRuntimeIdentityFallback: false,
          })
        ),
      getKanbanState: (options) => boardRead((board) => board.getKanbanState(options)),
      listReviewers: () => boardRead((board) => board.listReviewers()),
    },
    processes: createControllerProcessPolicy(join(root, 'teams', teamName, 'processes.json')),
    taskBoard: (actor) => {
      const controller = createTeamController(root, teamName, actor === 'user');
      const board = controller.taskBoard;
      // Prepared Task publication bypasses controller write caches; the canonical
      // board lock supplies a fresh scan context for every owner read.
      const read = <T>(action: () => T): T =>
        boardLock.withTeamBoardLock({ teamDir: join(root, 'teams', teamName) }, action);
      return {
        ...board,
        startTaskNotifying: (input) =>
          startTaskNotifying({
            board,
            send: controller.messages.sendMessage,
            root,
            teamName,
            input,
          }),
        getTask: (id) => read(() => board.getTask(id)),
        listTasks: () => read(() => board.listTasks()),
        listDeletedTasks: () => read(() => board.listDeletedTasks()),
      };
    },
    sendMessage: (actor, flags) =>
      createTeamController(root, teamName, actor === 'user').messages.sendMessage(flags),
    sendGroupMessage(flags) {
      const { member, ...row } = flags;
      if (typeof member !== 'string' || typeof row.messageId !== 'string')
        throw new Error('Invalid group destination');
      const file = join(root, 'teams', teamName, 'inboxes', `${safeSegment(member)}.json`);
      return withTeamFileFence(file, () => {
        const rows = readGroupFile(file) ?? [];
        assertValidGroupInboxRows(rows);
        const matches = rows.filter(
          (value) =>
            !!value &&
            typeof value === 'object' &&
            'messageId' in value &&
            value.messageId === row.messageId
        );
        if (matches.length) throw new Error('Conflicting group physical identity');
        assertValidGroupInboxRows([row]);
        rows.push(row);
        writeGroupFile(file, rows, writeTeamJson);
        return {
          messageId: row.messageId as string,
          message: JSON.parse(JSON.stringify(row)) as JsonValue,
        };
      });
    },
    sendCrossTeamMessage: (flags) =>
      messageStore.sendInboxMessage(createTeamController(root, teamName).context.paths, flags),
    appendSentMessage: (flags) =>
      createTeamController(root, teamName).messages.appendSentMessage(flags),
    readSentMessages() {
      try {
        const value: unknown = JSON.parse(
          readFileSync(join(root, 'teams', teamName, 'sentMessages.json'), 'utf8')
        );
        if (!Array.isArray(value)) throw new Error('Invalid sent messages');
        return value as JsonValue[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
    readInbox(member) {
      try {
        const value: unknown = JSON.parse(
          readFileSync(join(root, 'teams', teamName, 'inboxes', `${member}.json`), 'utf8')
        );
        if (!Array.isArray(value)) throw new Error('Invalid inbox');
        return value as JsonValue[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}
