import { crossTeamOutboxRecord } from './crossTeamRecords.js';
import { randomUUID } from 'node:crypto';
import { TeamOwnerError } from '../team/contracts.js';
import { effectId } from '../team/identity.js';
import {
  crossTeamIntentFingerprint,
  createTeamCrossTeamCommands,
} from './TeamCrossTeamCommands.js';

import type { CrossTeamOutbox } from './CrossTeamOutbox.js';
import type { CascadeGuard } from './CascadeGuard.js';
import type {
  HostCrossTeamSend,
  BackendCrossTeamReceipt,
  CapturedCrossTeamIdentity,
  CapturedCrossTeamIntent,
} from './contracts.js';

type SourceCommands = ReturnType<typeof createTeamCrossTeamCommands>;
export interface TargetCrossTeamReceipt {
  commandId: string;
  messageId: string;
  authorityFingerprint: string;
  phase: 'prepared' | 'applying' | 'completed' | 'held' | 'rejected';
}
export interface CapturedCrossTeamTarget {
  /** Read-only lookup of the existing ordinary target message command receipt. */
  lookup(commandId: string): TargetCrossTeamReceipt | undefined;
  /** Reuses ordinary Team message preparation/commit and native delivery intent. */
  receive(intent: CapturedCrossTeamIntent): TargetCrossTeamReceipt;
  /** Current original target grant and recipient/run; never selects a replacement. */
  assertOriginal(intent: CapturedCrossTeamIntent): void;
}

/** One same-Host conversation; no native delivery queue or alternate inbox writer. */
export function createHostCrossTeamCoordinator(options: {
  commands: SourceCommands;
  outbox: Pick<CrossTeamOutbox, 'appendIfNotRecent'>;
  cascade: Pick<CascadeGuard, 'check' | 'record'>;
  /** Captured both bindings before dispatch. Resolves member/grants only for new admission. */
  captureOriginal(request: HostCrossTeamSend): CapturedCrossTeamIdentity;
  /** Explicit binding comparison; resolves original Team ID only, never a name or default. */
  target(original: CapturedCrossTeamIdentity['target']): CapturedCrossTeamTarget;
  appendSenderCopy(intent: CapturedCrossTeamIntent): void;
  /** Existing canonical active-conversation policy, applied only for genuinely new admission. */
  resolveConversation?(
    request: HostCrossTeamSend,
    pair: CapturedCrossTeamIdentity
  ): {
    conversationId: string;
    replyToConversationId?: string;
  };
  assertCurrent(): void;
}) {
  function exactTarget(
    intent: CapturedCrossTeamIntent,
    result: TargetCrossTeamReceipt | undefined
  ): void {
    if (
      !result ||
      result.commandId !== intent.targetCommandId ||
      result.messageId !== intent.request.messageId ||
      result.authorityFingerprint !== intent.authorityFingerprint ||
      result.phase !== 'completed'
    )
      throw new TeamOwnerError('hold');
  }
  function originalTarget(intent: CapturedCrossTeamIntent): CapturedCrossTeamTarget {
    options.assertCurrent();
    return options.target(intent.pair.target);
  }
  return Object.freeze({
    /** prepared source history remains inspectable without creating a replacement grant or replaying effects. */
    lookup(commandId: string) {
      options.assertCurrent();
      const source = options.commands.lookup(commandId);
      if (!source) return undefined;
      const target = originalTarget(source.intent).lookup(source.intent.targetCommandId);
      options.assertCurrent();
      return { source, target };
    },
    async send(
      commandId: string,
      requestDigest: string,
      rawRequest: HostCrossTeamSend
    ): Promise<BackendCrossTeamReceipt> {
      const request = structuredClone(rawRequest);
      if (request.messageId !== commandId) throw new TeamOwnerError('invalid');
      options.assertCurrent();
      const source = options.commands.prepare(commandId, requestDigest, () => {
        const pair = structuredClone(options.captureOriginal(request));
        const { target: _opaqueTarget, ...payload } = request;
        const conversation = options.resolveConversation?.(request, pair) ?? {
          conversationId: request.conversationId ?? request.replyToConversationId ?? randomUUID(),
          ...(request.replyToConversationId === undefined
            ? {}
            : { replyToConversationId: request.replyToConversationId }),
        };
        const original = {
          commandId,
          pair,
          request: {
            ...payload,
            ...conversation,
            fromMember: pair.source.actor,
            toMember: pair.target.recipient.name,
          },
          timestamp: request.timestamp ?? new Date().toISOString(),
          targetCommandId: effectId(
            'cross-team-inbox',
            pair.source.teamId,
            pair.target.teamId,
            commandId
          ),
        };
        return { ...original, authorityFingerprint: crossTeamIntentFingerprint(original) };
      });
      const intent = source.intent;
      const target = originalTarget(intent);
      if (source.phase === 'completed') {
        exactTarget(intent, target.lookup(intent.targetCommandId));
        return { ...source.result!, deduplicated: true };
      }
      const row = crossTeamOutboxRecord(intent);
      const result = await options.outbox.appendIfNotRecent(
        intent.pair.source.teamName,
        row,
        async () => {
          options.assertCurrent();
          options.commands.assertCurrent(source);
          target.assertOriginal(intent);
          const old = target.lookup(intent.targetCommandId);
          if (!old) {
            options.cascade.check(
              intent.pair.source.teamId,
              intent.pair.target.teamId,
              row.chainDepth
            );
            options.cascade.record(intent.pair.source.teamId, intent.pair.target.teamId);
          }
          exactTarget(intent, target.receive(intent));
          // These effects remain within their respective original Team fences.
          options.commands.assertCurrent(source);
          options.appendSenderCopy(intent);
        },
        undefined,
        {
          stableIdentity: true,
          callerMessageId: intent.request.messageId,
          exactAuthority: intent.authorityFingerprint,
          assertCurrent: () => {
            options.assertCurrent();
            options.commands.assertCurrent(source);
            target.assertOriginal(intent);
          },
        }
      );
      options.assertCurrent();
      options.commands.assertCurrent(source);
      exactTarget(intent, target.lookup(intent.targetCommandId));
      if (result.duplicate) options.appendSenderCopy(intent);
      const response: BackendCrossTeamReceipt = {
        kind: 'cross-team-receipt',
        commandId,
        messageId: intent.request.messageId,
        conversationId: intent.request.conversationId,
        toMember: intent.pair.target.recipient.name,
        phase: 'completed',
        deduplicated: !!result.duplicate,
      };
      options.commands.complete(source, response);
      return response;
    },
  });
}
