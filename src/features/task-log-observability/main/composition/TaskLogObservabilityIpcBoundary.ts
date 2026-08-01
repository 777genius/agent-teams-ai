import {
  registerTaskLogObservabilityIpc as registerObservabilityIpc,
  removeTaskLogObservabilityIpc as removeObservabilityIpc,
} from '../adapters/input/ipc/registerTaskLogObservabilityIpc';

import type { TaskLogObservabilityReaders } from '../../core/application/ports/TaskLogObservabilityReaders';

export interface TaskLogObservabilityIpcLogger {
  error(message: string): void;
}

export interface TaskLogObservabilityIpcDependencies {
  readers: TaskLogObservabilityReaders;
  logger: TaskLogObservabilityIpcLogger;
}

export interface TaskLogObservabilityIpcRegistrar {
  readonly handle: CallableFunction;
  readonly removeHandler: CallableFunction;
}

export type TaskLogObservabilityIpcEvent = unknown;

export function registerTaskLogObservabilityIpc(
  ipcMain: TaskLogObservabilityIpcRegistrar,
  dependencies: TaskLogObservabilityIpcDependencies
): void {
  registerObservabilityIpc(ipcMain, dependencies);
}

export function removeTaskLogObservabilityIpc(ipcMain: TaskLogObservabilityIpcRegistrar): void {
  removeObservabilityIpc(ipcMain);
}
