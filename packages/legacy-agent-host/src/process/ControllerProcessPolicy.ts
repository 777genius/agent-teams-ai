import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';

import { validateProcessRow } from './validateProcessRecords.js';
import type { ProcessRegistryPolicy } from './TeamProcessCommands.js';
import type { TeamProcessRow } from './registeredProcessContracts.js';

interface ControllerProcessStore {
  registerProcess(paths: { processesPath: string }, flags: Record<string, unknown>): TeamProcessRow;
  stopProcess(
    paths: { processesPath: string },
    flags: { id: string } | { pid: number }
  ): TeamProcessRow;
  unregisterProcess(
    paths: { processesPath: string },
    flags: { id: string } | { pid: number }
  ): TeamProcessRow[];
  writeProcesses(paths: { processesPath: string }, rows: TeamProcessRow[]): void;
}
/** Fixed trusted Team path; called only inside existing Team authority/namespace fence.
 * Reuse controller metadata policy/writer. Never call its liveness-repairing listProcesses. */
export function createControllerProcessPolicy(processesPath: string): ProcessRegistryPolicy {
  const policy = createRequire(import.meta.url)(
    'agent-teams-controller/src/internal/processStore.js'
  ) as ControllerProcessStore;
  const paths = { processesPath };
  const hold = (): never => {
    throw new Error('process:hold');
  };
  const readStrict = (): TeamProcessRow[] => {
    let descriptor: number | undefined;
    let selected = false;
    try {
      const before = lstatSync(processesPath);
      selected = true;
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        before.size > 8 * 1024 * 1024
      )
        return hold();
      descriptor = openSync(processesPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(descriptor),
        bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (!count) return hold();
        offset += count;
      }
      if (readSync(descriptor, Buffer.alloc(1), 0, 1, bytes.length)) return hold();
      const after = fstatSync(descriptor),
        final = lstatSync(processesPath);
      if (
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        opened.nlink !== 1 ||
        after.nlink !== 1 ||
        final.nlink !== 1 ||
        final.isSymbolicLink() ||
        final.dev !== opened.dev ||
        final.ino !== opened.ino ||
        final.mtimeMs !== after.mtimeMs ||
        final.ctimeMs !== after.ctimeMs ||
        bytes.length !== before.size
      )
        return hold();
      const rows: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!Array.isArray(rows) || rows.length > 1024) return hold();
      const result = rows.map((row) => validateProcessRow(row as TeamProcessRow));
      if (new Set(result.map((row) => row.id)).size !== result.length) return hold();
      return result;
    } catch (error) {
      if (!selected && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return hold();
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };
  return {
    readStrict,
    register(input) {
      readStrict();
      const result = policy.registerProcess(paths, { ...input });
      readStrict();
      return result;
    },
    attachOriginal(id, commandId, capture) {
      const rows = readStrict(),
        selected = rows.filter((row) => row.id === id);
      if (selected.length !== 1) return hold();
      const result = {
        ...selected[0]!,
        capturedNative: structuredClone(capture),
        capturedByCommand: commandId,
      };
      validateProcessRow(result);
      policy.writeProcesses(
        paths,
        rows.map((row) => (row.id === id ? result : row))
      );
      readStrict();
      return result;
    },
    stopMetadata(selector) {
      readStrict();
      const result = policy.stopProcess(paths, selector);
      readStrict();
      return result;
    },
    unregister(selector) {
      readStrict();
      const result = policy.unregisterProcess(paths, selector);
      readStrict();
      return result;
    },
  };
}
