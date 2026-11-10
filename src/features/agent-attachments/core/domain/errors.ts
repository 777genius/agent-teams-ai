import type { AgentAttachmentErrorJson, AttachmentDeliveryFailureCode } from './types';

export class AgentAttachmentError extends Error {
  readonly code: AttachmentDeliveryFailureCode;
  readonly options: {
    providerId?: string;
    model?: string;
    attachmentId?: string;
    retryable?: boolean;
    safeDetails?: Record<string, string | number | boolean | null>;
  };

  constructor(
    code: AttachmentDeliveryFailureCode,
    message: string,
    options: AgentAttachmentError['options'] = {}
  ) {
    super(message);
    this.code = code;
    this.options = options;
    this.name = 'AgentAttachmentError';
  }

  toJSON(): AgentAttachmentErrorJson {
    return {
      code: this.code,
      message: this.message,
      retryable: this.options.retryable ?? false,
      ...(this.options.providerId ? { providerId: this.options.providerId } : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.attachmentId ? { attachmentId: this.options.attachmentId } : {}),
      ...(this.options.safeDetails ? { safeDetails: this.options.safeDetails } : {}),
    };
  }
}
