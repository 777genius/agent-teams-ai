import { z } from 'zod';

import { TeamOwnerError } from '../team/contracts.js';
import { effectId } from '../team/identity.js';
import { crossTeamIntentFingerprint } from './TeamCrossTeamCommands.js';

import type { CapturedCrossTeamIntent } from './contracts.js';

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\S(?:[\s\S]*\S)?$/);
const teamName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/);
const memberName = z.string().min(1).max(128);
const side = z.strictObject({
  resourceRef: identifier,
  teamResourceRef: identifier,
  handleId: identifier.optional(),
  scope: z.strictObject({
    projectId: identifier,
    workspaceId: identifier,
    teamId: identifier,
    runId: identifier,
    memberId: identifier.nullable(),
    generation: z.union([identifier, z.number().int()]).nullable(),
  }),
  teamId: identifier,
  teamName,
  principalId: identifier,
  grantRevision: z.number().int().positive(),
  actor: memberName,
  runId: identifier.optional(),
  sender: z
    .strictObject({ memberId: identifier, runId: identifier, generation: identifier })
    .optional(),
});
const schema = z.strictObject({
  commandId: identifier,
  pair: z.strictObject({
    ownerId: identifier,
    ownerRevision: identifier,
    ownerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    contextId: identifier.optional(),
    source: side,
    target: side.extend({
      recipient: z.strictObject({
        memberId: identifier,
        name: memberName,
        runId: identifier,
        generation: identifier,
      }),
    }),
  }),
  request: z.strictObject({
    fromMember: memberName,
    toMember: memberName.optional(),
    text: z.string().min(1).max(48_000),
    messageId: identifier,
    conversationId: identifier,
    replyToConversationId: identifier.optional(),
    timestamp: identifier.optional(),
    summary: z.string().max(4_000).optional(),
    actionMode: z.enum(['do', 'ask', 'delegate']).optional(),
    taskRefs: z
      .array(
        z.strictObject({
          taskId: identifier,
          displayId: identifier,
          team: z.enum(['source', 'target']),
        })
      )
      .max(100)
      .optional(),
    chainDepth: z.number().int().min(0).max(4).optional(),
  }),
  timestamp: identifier,
  authorityFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  targetCommandId: identifier,
});

/** Receipt context is private authority data, never part of the ordinary message schema. */
export function validateCrossTeamIntent(intent: CapturedCrossTeamIntent): void {
  if (
    Buffer.byteLength(JSON.stringify(intent), 'utf8') > 96 * 1024 ||
    !schema.safeParse(intent).success ||
    intent.commandId !== intent.request.messageId ||
    intent.pair.source.teamId === intent.pair.target.teamId ||
    intent.pair.source.resourceRef === intent.pair.target.resourceRef ||
    (intent.pair.source.handleId !== undefined &&
      intent.pair.source.handleId === intent.pair.target.handleId) ||
    intent.pair.source.scope.teamId !== intent.pair.source.teamId ||
    intent.pair.target.scope.teamId !== intent.pair.target.teamId ||
    intent.request.fromMember !== intent.pair.source.actor ||
    (intent.pair.source.actor !== 'user' && !intent.pair.source.sender) ||
    (intent.request.toMember !== undefined &&
      intent.request.toMember !== intent.pair.target.recipient.name) ||
    !Number.isFinite(Date.parse(intent.timestamp)) ||
    (intent.request.timestamp !== undefined && intent.request.timestamp !== intent.timestamp) ||
    intent.targetCommandId !==
      effectId(
        'cross-team-inbox',
        intent.pair.source.teamId,
        intent.pair.target.teamId,
        intent.commandId
      ) ||
    intent.authorityFingerprint !== crossTeamIntentFingerprint(intent)
  )
    throw new TeamOwnerError('hold');
}
