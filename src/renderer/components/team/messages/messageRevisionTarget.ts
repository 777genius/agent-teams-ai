export interface MessageRevisionDraftTarget {
  readonly addressKey: string;
  readonly loadGeneration: number;
}

export interface MessageRevisionTargetController {
  readonly prepare: (
    recipient: string,
    signal: AbortSignal
  ) => Promise<MessageRevisionDraftTarget | null>;
  readonly isCurrent: (target: MessageRevisionDraftTarget) => boolean;
}
