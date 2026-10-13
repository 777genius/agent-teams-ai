import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';

import { resolveAgentAttachmentCapability } from '../../core/domain';

import type {
  NativeInboxAttachmentCapabilityProof,
  NativeWorkSyncAdmissionProviderId,
} from '@features/member-work-sync/main';
import type {
  AttachmentPayload,
  SendMessageRequest,
  SendMessageResult,
  TeamAgentRuntimeSnapshot,
  TeamProviderId,
  TeamViewSnapshot,
} from '@shared/types';

const MAX_NATIVE_BYTES_PER_FILE = 4 * 1024 * 1024;
const MAX_NATIVE_BYTES_TOTAL = 8 * 1024 * 1024;
const MAX_NATIVE_ATTACHMENTS = 5;

export type NativeAttachmentCapabilityReader = (input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
  expectedProviderId: NativeWorkSyncAdmissionProviderId;
}) => Promise<NativeInboxAttachmentCapabilityProof | null>;

export type NativeAttachmentRuntimeReader = (teamName: string) => Promise<TeamAgentRuntimeSnapshot>;

export interface NativeAttachmentStore {
  saveNativeAttachments(
    teamName: string,
    messageId: string,
    attachments: AttachmentPayload[]
  ): Promise<NativeStoredAttachmentMeta[]>;
}

export interface NativeStoredAttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  filePath: string;
  sha256: string;
}

export interface NativeAttachmentInboxRequest extends Omit<SendMessageRequest, 'attachments'> {
  attachments: NativeStoredAttachmentMeta[];
  recipientRuntimeInstanceId: string;
}

export type NativeAttachmentInboxWriter = (
  teamName: string,
  request: NativeAttachmentInboxRequest,
  options: { shouldStillWrite: () => Promise<boolean> }
) => Promise<SendMessageResult>;

export interface NativeTeammateAttachmentAdmissionDependencies {
  teamsBasePath: string;
  readCapability: NativeAttachmentCapabilityReader;
  readRuntimeSnapshot: NativeAttachmentRuntimeReader;
  attachmentStore: NativeAttachmentStore;
  writeInbox: NativeAttachmentInboxWriter;
  runWithLiveRosterMutation(teamName: string, operation: () => Promise<void>): Promise<void>;
  isProcessAlive(pid: number): boolean;
}

export interface NativeTeammateAttachmentAdmissionInput {
  teamName: string;
  memberName: string;
  providerId: TeamProviderId;
  messageId: string;
  request: Omit<SendMessageRequest, 'attachments'>;
  attachments: AttachmentPayload[];
}

export function isNativeAttachmentRecipient(input: {
  isLeadRecipient: boolean;
  providerId?: TeamProviderId;
}): boolean {
  return (
    !input.isLeadRecipient && (input.providerId === 'anthropic' || input.providerId === 'codex')
  );
}

export async function admitNativeTeammateAttachmentMessage(
  input: NativeTeammateAttachmentAdmissionInput,
  deps: NativeTeammateAttachmentAdmissionDependencies
): Promise<SendMessageResult> {
  if (!isNativeAttachmentRecipient({ isLeadRecipient: false, providerId: input.providerId })) {
    throw new Error('Native teammate attachments require a Claude or Codex recipient');
  }

  let result: SendMessageResult | null = null;
  await deps.runWithLiveRosterMutation(input.teamName, async () => {
    const firstProof = await requireCurrentNativeActor(input, deps);
    validateNativeAttachmentBatch(input.attachments, input.providerId, firstProof);
    const stored = await deps.attachmentStore.saveNativeAttachments(
      input.teamName,
      input.messageId,
      input.attachments
    );
    if (stored.length !== input.attachments.length) {
      throw new Error('Attachment storage did not complete the full batch');
    }

    const secondProof = await requireCurrentNativeActor(input, deps);
    if (secondProof.runtimeInstanceId !== firstProof.runtimeInstanceId) {
      throw new Error('Native teammate runtime changed during attachment admission');
    }
    const request: NativeAttachmentInboxRequest = {
      ...input.request,
      member: input.memberName,
      messageId: input.messageId,
      attachments: stored,
      recipientRuntimeInstanceId: secondProof.runtimeInstanceId,
    };
    result = await deps.writeInbox(input.teamName, request, {
      shouldStillWrite: async () => {
        try {
          const proof = await requireCurrentNativeActor(input, deps);
          return proof.runtimeInstanceId === secondProof.runtimeInstanceId;
        } catch {
          return false;
        }
      },
    });
    if (!result.deliveredToInbox) {
      throw new Error('Native teammate attachment message was not admitted to the inbox');
    }
  });
  if (!result) throw new Error('Native teammate attachment admission produced no result');
  return result;
}

export async function enrichTeamSnapshotNativeAttachmentSupport(input: {
  teamName: string;
  snapshot: TeamViewSnapshot;
  deps: Pick<
    NativeTeammateAttachmentAdmissionDependencies,
    'teamsBasePath' | 'readCapability' | 'readRuntimeSnapshot' | 'isProcessAlive'
  >;
}): Promise<TeamViewSnapshot> {
  const runtimeSnapshot = await input.deps.readRuntimeSnapshot(input.teamName).catch(() => null);
  const members = await Promise.all(
    input.snapshot.members.map(async (member) => {
      const providerId =
        normalizeOptionalTeamProviderId(member.providerId) ??
        inferTeamProviderIdFromModel(member.model);
      const native = isNativeAttachmentRecipient({
        isLeadRecipient: false,
        providerId,
      });
      if (!native) return member;
      if (!runtimeSnapshot)
        return {
          ...member,
          nativeInboxAttachmentsSupported: false,
          nativeInboxTextAttachmentsSupported: false,
        };
      const expectedProviderId =
        providerId === 'codex' ? ('codex' as const) : ('anthropic' as const);
      const proof = await input.deps.readCapability({
        teamsBasePath: input.deps.teamsBasePath,
        teamName: input.teamName,
        memberName: member.name,
        expectedProviderId,
      });
      const current = isCurrentNativeActor(
        member.name,
        proof,
        runtimeSnapshot,
        input.deps.isProcessAlive
      );
      return {
        ...member,
        nativeInboxAttachmentsSupported: current,
        nativeInboxTextAttachmentsSupported:
          current && providerId === 'codex' && proof?.nativeInboxAttachmentsVersion === 2,
      };
    })
  );
  return { ...input.snapshot, members };
}

function validateNativeAttachmentBatch(
  attachments: readonly AttachmentPayload[],
  providerId: TeamProviderId,
  proof: NativeInboxAttachmentCapabilityProof
): void {
  if (attachments.length === 0 || attachments.length > MAX_NATIVE_ATTACHMENTS) {
    throw new Error(
      `Native teammate attachment count must be between 1 and ${MAX_NATIVE_ATTACHMENTS}`
    );
  }
  const capability = resolveAgentAttachmentCapability({
    providerId,
    nativeInboxTextAttachmentsSupported: proof.nativeInboxAttachmentsVersion === 2,
  });
  const ids = new Set<string>();
  let total = 0;
  for (const attachment of attachments) {
    if (ids.has(attachment.id)) throw new Error(`Duplicate attachment ID: ${attachment.id}`);
    ids.add(attachment.id);
    if (
      attachment.data.length === 0 ||
      attachment.data.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attachment.data)
    ) {
      throw new Error(`Attachment data is not valid base64: ${attachment.filename}`);
    }
    const buffer = Buffer.from(attachment.data, 'base64');
    if (buffer.length !== attachment.size || buffer.length > MAX_NATIVE_BYTES_PER_FILE) {
      throw new Error(`Attachment size is invalid or too large: ${attachment.filename}`);
    }
    const supportedImage = capability.supportedImageMimeTypes.includes(
      attachment.mimeType as (typeof capability.supportedImageMimeTypes)[number]
    );
    const supportedFile = capability.supportedFileMimeTypes.some((mime) =>
      mime.endsWith('/*') ? attachment.mimeType === 'text/plain' : attachment.mimeType === mime
    );
    if (!supportedImage && !supportedFile) {
      throw new Error(`Attachment type is not supported by ${providerId}: ${attachment.mimeType}`);
    }
    if (providerId === 'codex' && attachment.mimeType === 'text/plain') {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        throw new Error(`Codex text attachment is not valid UTF-8: ${attachment.filename}`);
      }
    }
    total += buffer.length;
  }
  if (total > MAX_NATIVE_BYTES_TOTAL) {
    throw new Error('Native teammate attachments exceed the 8 MiB combined limit');
  }
}

async function requireCurrentNativeActor(
  input: NativeTeammateAttachmentAdmissionInput,
  deps: NativeTeammateAttachmentAdmissionDependencies
): Promise<NativeInboxAttachmentCapabilityProof> {
  const proof = await deps.readCapability({
    teamsBasePath: deps.teamsBasePath,
    teamName: input.teamName,
    memberName: input.memberName,
    expectedProviderId: input.providerId === 'codex' ? 'codex' : 'anthropic',
  });
  const snapshot = await deps.readRuntimeSnapshot(input.teamName);
  if (!proof) {
    throw new Error(
      'Native teammate attachment capability is missing, stale, or belongs to another run'
    );
  }
  if (!isCurrentNativeActor(input.memberName, proof, snapshot, deps.isProcessAlive)) {
    throw new Error(
      'Native teammate attachment capability is missing, stale, or belongs to another run'
    );
  }
  if (
    input.providerId === 'codex' &&
    input.attachments.some((attachment) => attachment.mimeType === 'text/plain') &&
    proof.nativeInboxAttachmentsVersion !== 2
  ) {
    throw new Error('Codex text attachments require a current version 2 native runtime');
  }
  return proof;
}

function isCurrentNativeActor(
  memberName: string,
  proof: NativeInboxAttachmentCapabilityProof | null,
  snapshot: TeamAgentRuntimeSnapshot,
  isProcessAlive: (pid: number) => boolean
): boolean {
  if (!proof) return false;
  const member = snapshot.members[memberName];
  if (!member?.alive) return false;
  const pid = member.runtimePid ?? member.pid;
  if (!pid || pid !== proof.pid || !isProcessAlive(pid)) return false;
  return (
    proof.bootstrapRunId === snapshot.runId || proof.bootstrapRunId === member.runtimeSessionId
  );
}
