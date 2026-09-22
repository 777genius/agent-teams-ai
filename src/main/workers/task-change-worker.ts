import { parentPort } from 'node:worker_threads';

import { TaskBoundaryParser } from '@main/services/team/TaskBoundaryParser';
import { TaskChangeComputer } from '@main/services/team/TaskChangeComputer';
import { TeamMemberLogsFinder } from '@main/services/team/TeamMemberLogsFinder';

import type {
  TaskChangeWorkerRequest,
  TaskChangeWorkerResponse,
} from '@main/services/team/taskChangeWorkerTypes';

const logsFinder = new TeamMemberLogsFinder();
const boundaryParser = new TaskBoundaryParser();
const computer = new TaskChangeComputer(logsFinder, boundaryParser);

function postMessage(message: TaskChangeWorkerResponse): void {
  parentPort?.postMessage(message);
}

parentPort?.on('message', async (message: TaskChangeWorkerRequest) => {
  if (message?.op !== 'computeTaskChanges') {
    postMessage({
      id: message?.id ?? 'unknown',
      ok: false,
      error: `Unsupported task change worker op: ${String(message?.op)}`,
    });
    return;
  }

  try {
    const result = await computer.computeTaskChanges(message.payload);
    postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
