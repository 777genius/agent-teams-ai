import { AttachmentArtifactStore } from '../attachments/AttachmentArtifactStore.js';
import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { attachmentUploadSchema } from '../attachments/uploadContracts.js';
import { attachmentMetadataSchema } from '../attachments/contracts.js';
import { z } from 'zod';
import { digest } from '../team/identity.js';
import { TeamOwnerError } from '../team/contracts.js';
import {
  taskAttachmentReadSchema,
  messageAttachmentReadSchema,
  messageAttachmentsReadSchema,
} from '../attachments/contracts.js';
import type { ImportedAttachmentResult } from '../attachments/contracts.js';
import type { HostMethod } from '../index.js';
import { importedMessageTaskId } from '../attachments/importedMessageReference.js';
import type { JsonValue } from '../contracts.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { HostedTeam } from './RuntimeTeamCoordinator.js';

const envelope = z
  .object({
    binding: z
      .object({
        schemaVersion: z.literal(1),
        handleId: z
          .string()
          .min(1)
          .max(256)
          .refine((value) => !value.includes('\0')),
        owner: z.unknown(),
        scope: z.unknown(),
      })
      .strict(),
    commandId: z.string().min(1).max(256),
    payload: z.unknown(),
  })
  .strict();
export function createTeamAttachmentComposition(options: {
  profile: Pick<TeamHostProfile, 'owner' | 'principalId'>;
  teams: ReadonlyMap<string, HostedTeam>;
  assertCurrent(): void;
  read?:
    | ((teamId: string, task: unknown, payload: unknown) => ImportedAttachmentResult)
    | undefined;
}) {
  const methods: Record<string, HostMethod> = {};
  for (const mode of ['task', 'message', 'list', 'upload'] as const) {
    const method =
      mode === 'task'
        ? 'team.task.attachment.read'
        : mode === 'upload'
          ? 'team.attachment.upload'
          : mode === 'message'
            ? 'team.message.attachment.read'
            : 'team.message.attachments.read';
    methods[method] = {
      lane: mode === 'upload' ? 'work' : 'control',
      async handle(raw): Promise<JsonValue> {
        try {
          options.assertCurrent();
          const input = envelope.parse(raw);
          const payload =
            mode === 'upload'
              ? attachmentUploadSchema.parse(input.payload)
              : mode === 'task'
                ? taskAttachmentReadSchema.parse(input.payload)
                : mode === 'message'
                  ? messageAttachmentReadSchema.parse(input.payload)
                  : messageAttachmentsReadSchema.parse(input.payload);
          const scope = input.binding.scope as { teamId?: string } | null;
          const selected =
            scope && typeof scope.teamId === 'string' ? options.teams.get(scope.teamId) : undefined;
          if (
            !selected ||
            digest(input.binding.owner) !== digest(options.profile.owner) ||
            digest(input.binding.scope) !== digest(selected.definition.scope)
          )
            throw new TeamOwnerError('forbidden');
          const store = new AttachmentArtifactStore(
            options.profile.owner.storageRoot,
            selected.definition.binding,
            new TeamOwnerStore(
              options.profile.owner.storageRoot,
              selected.definition.binding.teamName
            )
          );
          if (mode === 'upload') {
            const upload = attachmentUploadSchema.parse(payload);
            const result = selected.owner.withLaunchAuthority(
              options.profile.principalId,
              'control',
              () => {
                selected.owner.assertExecutionAllowed(options.profile.principalId);
                if (upload.purpose.kind === 'task')
                  selected.connection.getTask(upload.purpose.taskId);
                else {
                  const memberName = upload.purpose.member;
                  if (
                    !selected.connection
                      .readRoster()
                      .members.some((member) => member.name === memberName)
                  )
                    throw new TeamOwnerError('invalid');
                }
                options.assertCurrent();
                const value = store.upload(upload);
                options.assertCurrent();
                return value;
              }
            );
            return { ok: true, value: JSON.parse(JSON.stringify(result)) as JsonValue };
          }
          const taskPayload = mode === 'task' ? taskAttachmentReadSchema.parse(payload) : undefined;
          const messagePayload =
            mode === 'message'
              ? messageAttachmentReadSchema.parse(payload)
              : mode === 'list'
                ? messageAttachmentsReadSchema.parse(payload)
                : undefined;
          const imported = messagePayload?.reference.startsWith('im1:');
          const taskId =
            taskPayload?.taskId ??
            (imported ? importedMessageTaskId(messagePayload!.reference) : undefined);
          const value = selected.owner.withLaunchAuthority(
            options.profile.principalId,
            'read',
            () => {
              const task = taskId ? selected.connection.getTask(taskId) : undefined;
              if (taskId && !task) return null;
              let value: ImportedAttachmentResult;
              if (taskPayload) {
                const current = task as {
                  attachments?: unknown[];
                  comments?: { attachments?: unknown[] }[];
                };
                const metadata = [
                  ...(current.attachments ?? []),
                  ...(current.comments ?? []).flatMap((comment) => comment.attachments ?? []),
                ];
                const owned = store.read(
                  metadata,
                  taskPayload.attachmentId,
                  taskPayload.offset,
                  taskPayload.expectedSha256
                );
                value =
                  owned ??
                  options.read?.(selected.definition.binding.teamId, task, payload) ??
                  null;
              } else if (imported) {
                if (!options.read) throw new TeamOwnerError('hold');
                value = options.read(selected.definition.binding.teamId, task, {
                  ...payload,
                  messageMode: mode,
                });
              } else {
                const snapshot = selected.connection.readSnapshot() as {
                  messages?: { messageId?: string; attachments?: unknown[] }[];
                };
                const messages =
                  snapshot.messages?.filter((row) => row.messageId === messagePayload!.reference) ??
                  [];
                if (
                  messages.length > 1 &&
                  new Set(messages.map((row) => digest(row.attachments))).size > 1
                )
                  throw new TeamOwnerError('hold');
                const metadata = messages[0]?.attachments ?? [];
                if (mode === 'list')
                  value = metadata.map((item) =>
                    attachmentMetadataSchema.parse(
                      Object.fromEntries(
                        Object.entries(item as Record<string, unknown>).filter(([key]) =>
                          ['id', 'filename', 'mimeType', 'size', 'addedAt'].includes(key)
                        )
                      )
                    )
                  );
                else {
                  const chunk = messageAttachmentReadSchema.parse(payload);
                  value = store.read(
                    metadata,
                    chunk.attachmentId,
                    chunk.offset,
                    chunk.expectedSha256
                  );
                }
              }
              selected.connection.readRoster();
              options.assertCurrent();
              return value;
            }
          );
          return { ok: true, value: JSON.parse(JSON.stringify(value)) as JsonValue };
        } catch (error) {
          return {
            ok: false,
            code:
              error instanceof TeamOwnerError
                ? error.code
                : error instanceof z.ZodError
                  ? 'invalid'
                  : 'hold',
            outcome:
              mode === 'upload' &&
              !(error instanceof z.ZodError) &&
              !(error instanceof TeamOwnerError && error.code !== 'hold')
                ? 'unknown'
                : 'not-dispatched',
          };
        }
      },
    };
  }
  return { methods };
}
