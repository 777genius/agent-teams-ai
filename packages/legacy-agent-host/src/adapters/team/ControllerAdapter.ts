import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { JsonValue } from '../../contracts.js';
import type { TaskBoardPolicy, TeamPolicyPort } from '../../team/ports.js';

const require = createRequire(import.meta.url);

interface Controller {
  taskBoard: TaskBoardPolicy;
  messages: {
    sendMessage(flags: Record<string, unknown>): { messageId: string; message: JsonValue };
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
    }): Controller;
  };
  return api.createController({ claudeDir: root, teamName, allowUserMessageSender });
}

// These existing IO primitives retain the controller's filesystem lock protocol.
// Kept at this adapter boundary; Team policy never imports package internals.
const lock = require('agent-teams-controller/src/internal/fileLock.js') as {
  withFileLockSync<T>(scope: string, action: () => T): T;
};
const atomic = require('agent-teams-controller/src/internal/atomicFile.js') as {
  writeJsonFileSync(filePath: string, value: unknown): void;
};
const boardLock = require('agent-teams-controller/src/internal/boardLock.js') as {
  withTeamBoardLock<T>(paths: { teamDir: string }, action: () => T): T;
};

export const withTeamFileFence = lock.withFileLockSync;
export const writeTeamJson = atomic.writeJsonFileSync;

export function createTeamPolicy(root: string, teamName: string): TeamPolicyPort {
  return {
    taskBoard: (actor) => {
      const board = createTeamController(root, teamName, actor === 'user').taskBoard;
      // Prepared Task publication bypasses controller write caches; the canonical
      // board lock supplies a fresh scan context for every owner read.
      const read = <T>(action: () => T): T =>
        boardLock.withTeamBoardLock({ teamDir: join(root, 'teams', teamName) }, action);
      return {
        ...board,
        getTask: (id) => read(() => board.getTask(id)),
        listTasks: () => read(() => board.listTasks()),
        listDeletedTasks: () => read(() => board.listDeletedTasks()),
      };
    },
    sendMessage: (actor, flags) =>
      createTeamController(root, teamName, actor === 'user').messages.sendMessage(flags),
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
