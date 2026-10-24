import { HostTeamOperationError } from './createHostTeamMutations';

import type { BackendHandle } from '../contracts';
import type { AgentBackendApi, BackendOperationResult } from '../contracts/operations';
import type { BackendRosterReplacement } from '../contracts/roster';
import type { ReplaceMembersRequest } from '@shared/types/team';

function validReceipt(result: BackendOperationResult | undefined, commandId: string): boolean {
  return (
    !!result?.ok &&
    !!result.value &&
    'commandId' in result.value &&
    result.value.commandId === commandId &&
    'revision' in result.value &&
    typeof result.value.revision === 'string' &&
    /^[a-f0-9]{64}$/.test(result.value.revision)
  );
}

/** Existing Team API input only; revision always comes from the hydrated form. */
export function createHostTeamRoster(options: {
  backend: AgentBackendApi;
  captureScope(): () => boolean;
  resolve(key: string, current: () => boolean): Promise<{ handle: BackendHandle }>;
  invalidateReads(handle: BackendHandle): void;
}) {
  return {
    async replaceMembers(key: string, raw: ReplaceMembersRequest): Promise<void> {
      const request = structuredClone(raw),
        current = options.captureScope();
      const invalid: () => never = () => {
        throw new HostTeamOperationError('invalid-roster-intent', 'not-dispatched');
      };
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        Object.keys(request).some(
          (field) =>
            !['members', 'command', 'configuration', 'memberSettingsRelaunch'].includes(field)
        )
      )
        invalid();
      const command = request.command,
        configuration = request.configuration;
      if (
        !command ||
        !configuration ||
        Object.keys(command).some((field) => !['commandId', 'idempotencyKey'].includes(field)) ||
        Object.keys(configuration).some(
          (field) => !['expectedRevision', 'savedSettings'].includes(field)
        ) ||
        typeof command.commandId !== 'string' ||
        !command.commandId.trim() ||
        command.commandId.length > 256 ||
        command.commandId.includes('\0') ||
        command.commandId !== command.idempotencyKey ||
        !/^[a-f0-9]{64}$/.test(configuration.expectedRevision)
      )
        invalid();
      if (!current())
        throw new HostTeamOperationError('context-changed', 'not-dispatched', command.commandId);
      const target = await options.resolve(key, current);
      if (!current())
        throw new HostTeamOperationError('context-changed', 'not-dispatched', command.commandId);
      const handle = { ...target.handle };
      const payload: BackendRosterReplacement = {
        expectedRevision: configuration.expectedRevision,
        members: request.members,
        ...(configuration.savedSettings === undefined
          ? {}
          : { savedSettings: configuration.savedSettings }),
        ...(request.memberSettingsRelaunch === undefined
          ? {}
          : { memberSettingsRelaunch: request.memberSettingsRelaunch }),
      };
      options.invalidateReads(handle);
      try {
        let result: BackendOperationResult | undefined;
        let failure = new HostTeamOperationError(
          'transport-unavailable',
          'unknown',
          command.commandId
        );
        try {
          result = await options.backend.invoke({
            handle: { ...handle },
            commandId: command.commandId,
            operation: 'team.roster.replace',
            payload: structuredClone(payload),
          });
        } catch {
          /* An uncertain wire effect is resolved only through its original receipt below. */
        }
        if (!current())
          throw new HostTeamOperationError('context-changed', 'unknown', command.commandId);
        if (validReceipt(result, command.commandId)) return;
        if (result) {
          failure = result.ok
            ? new HostTeamOperationError('invalid-result', 'unknown', command.commandId)
            : new HostTeamOperationError(result.code, result.outcome, command.commandId);
          if (failure.outcome !== 'unknown') throw failure;
        }
        // One control read validates the exact original payload at the same owner.
        // No effect is retried and durable absence is not translated into success.
        let original: BackendOperationResult | undefined;
        try {
          original = await options.backend.invoke({
            handle: { ...handle },
            commandId: command.commandId,
            operation: 'team.roster.lookup',
            payload: { expected: structuredClone(payload) },
          });
        } catch {
          /* Retain the original uncertainty and command ID. */
        }
        if (!current())
          throw new HostTeamOperationError('context-changed', 'unknown', command.commandId);
        if (!validReceipt(original, command.commandId)) throw failure;
      } finally {
        if (current()) options.invalidateReads(handle);
      }
    },
  };
}
