import { validateTeamName } from '@main/ipc/guards';

import { normalizeSendTeamMessageCommand } from './normalizeSendTeamMessageCommand';

import type { TeamMessageDeliveryIpcDependencies } from './TeamMessageDeliveryIpcDependencies';
import type {
  AttachmentFileData,
  IpcResult,
  OpenCodeRuntimeDeliveryStatus,
  SendMessageResult,
} from '@shared/types';

type ExecutionResult<T> = { success: true; data: T } | { success: false; error: string };

export function createTeamMessageDeliveryIpcHandlers(
  dependencies: TeamMessageDeliveryIpcDependencies
): {
  sendMessage: (
    _event: unknown,
    teamName: unknown,
    request: unknown
  ) => Promise<IpcResult<SendMessageResult>>;
  getOpenCodeRuntimeDeliveryStatus: (
    _event: unknown,
    teamName: unknown,
    messageId: unknown
  ) => Promise<IpcResult<OpenCodeRuntimeDeliveryStatus | null>>;
  processSend: (_event: unknown, teamName: unknown, message: unknown) => Promise<IpcResult<void>>;
  processAlive: (_event: unknown, teamName: unknown) => Promise<IpcResult<boolean>>;
  getAttachments: (
    _event: unknown,
    teamName: unknown,
    messageId: unknown
  ) => Promise<IpcResult<AttachmentFileData[]>>;
} {
  const execute = async <T>(
    operation: string,
    handler: () => Promise<T>
  ): Promise<ExecutionResult<T>> => {
    try {
      return { success: true, data: await handler() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.error(`[teams:${operation}] ${message}`);
      return { success: false, error: message };
    }
  };

  return {
    sendMessage: async (_event, teamName, request) => {
      const normalized = normalizeSendTeamMessageCommand(teamName, request);
      if (!normalized.valid) return { success: false, error: normalized.error };

      const prevalidation = await execute('sendMessage', () =>
        dependencies.sendMessage.prevalidateDelegate(normalized.value)
      );
      if (!prevalidation.success) return prevalidation;
      const prevalidatedDelegate = prevalidation.data;
      if (prevalidatedDelegate && !prevalidatedDelegate.isLeadRecipient) {
        return {
          success: false,
          error: 'Delegate mode is only supported when messaging the team lead',
        };
      }
      return execute('sendMessage', () =>
        dependencies.sendMessage.execute(normalized.value, prevalidatedDelegate)
      );
    },

    getOpenCodeRuntimeDeliveryStatus: async (_event, teamName, messageId) => {
      const validatedTeamName = validateRequiredTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedMessageId = validateMessageId(messageId);
      if (!validatedMessageId.valid) {
        return { success: false, error: validatedMessageId.error };
      }
      return execute('getOpenCodeRuntimeDeliveryStatus', () =>
        dependencies.getOpenCodeRuntimeDeliveryStatus.execute(
          validatedTeamName.value,
          validatedMessageId.value
        )
      );
    },

    processSend: async (_event, teamName, message) => {
      const validatedTeamName = validateRequiredTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      if (typeof message !== 'string' || message.trim().length === 0) {
        return { success: false, error: 'message must be a non-empty string' };
      }
      return execute('processSend', () =>
        dependencies.sendProcessMessage.execute(validatedTeamName.value, message)
      );
    },

    processAlive: async (_event, teamName) => {
      const validatedTeamName = validateRequiredTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      return execute('processAlive', async () =>
        dependencies.getProcessAlive.execute(validatedTeamName.value)
      );
    },

    getAttachments: async (_event, teamName, messageId) => {
      const validatedTeamName = validateRequiredTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedMessageId = validateMessageId(messageId);
      if (!validatedMessageId.valid) {
        return { success: false, error: validatedMessageId.error };
      }
      return execute('getAttachments', () =>
        dependencies.getAttachments.execute(validatedTeamName.value, validatedMessageId.value)
      );
    },
  };
}

function validateRequiredTeamName(
  teamName: unknown
): { valid: true; value: string } | { valid: false; error: string } {
  const validated = validateTeamName(teamName);
  if (!validated.valid || typeof validated.value !== 'string') {
    return { valid: false, error: validated.error ?? 'Invalid teamName' };
  }
  return { valid: true, value: validated.value };
}

function validateMessageId(
  messageId: unknown
): { valid: true; value: string } | { valid: false; error: string } {
  if (typeof messageId !== 'string' || messageId.trim().length === 0) {
    return { valid: false, error: 'messageId must be a non-empty string' };
  }
  const value = messageId.trim();
  if (value.includes('/') || value.includes('\\') || value.includes('..')) {
    return { valid: false, error: 'Invalid messageId' };
  }
  return { valid: true, value };
}
