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

export const withTeamFileFence = lock.withFileLockSync;
export const writeTeamJson = atomic.writeJsonFileSync;

export function createTeamPolicy(root: string, teamName: string): TeamPolicyPort {
  return {
    taskBoard: (actor) => createTeamController(root, teamName, actor === 'user').taskBoard,
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
