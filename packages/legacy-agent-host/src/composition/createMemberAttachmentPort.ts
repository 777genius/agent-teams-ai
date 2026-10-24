import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  decorateFileReferences,
  getMessageAttachmentRoute,
  isStrictUtf8,
} from '../attachments/portable.js';
import type { Input } from '@agent-teams/provider-session-contracts';
import { AttachmentArtifactStore } from '../attachments/AttachmentArtifactStore.js';
import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { resolveAgentAttachmentCapability } from '../attachments/capabilities.js';
import { NATIVE_IMAGE_MIME_TYPES, NATIVE_VIDEO_MIME_TYPES } from '../attachments/mimeTypes.js';
import { TeamOwnerError } from '../team/contracts.js';
import type { MemberProviderContext } from '../adapters/providers/MemberProvider.js';
import type { MemberEntry } from './MemberEntry.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';

const require = createRequire(import.meta.url);
const { agentBlocks } = require('agent-teams-controller') as {
  agentBlocks: { wrapAgentBlock(text: string): string };
};
const fingerprint = (input: Input) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        input.content,
        (input.attachments ?? []).map((ref) => [
          ref.artifactId,
          ref.mimeType,
          ref.byteLength,
          ref.digest,
        ]),
      ])
    )
    .digest('hex');

/** D owns native formatting; this private port resolves only the exact claimed selected-Team input. */
export function createMemberAttachmentPort(options: {
  entry: MemberEntry;
  storageRoot: string;
  assertCurrent(): void;
  readRuntime: RuntimeOwner['readCapturedSession'];
}): { port: NonNullable<MemberProviderContext['attachments']>; prepareInput(input: Input): Input } {
  const { entry } = options;
  const target = entry.team.definition.members.find(
    (member) => member.memberId === entry.binding.memberId
  );
  const capability = resolveAgentAttachmentCapability({
    providerId: entry.profile.provider === 'claude' ? 'anthropic' : entry.profile.provider,
    model: entry.profile.model,
  });
  const model =
    entry.profile.provider === 'opencode'
      ? `${entry.profile.nativeOptions.providerId}/${entry.profile.model}`
      : entry.profile.model;
  // Transport ceiling only; the captured OpenCode adapter independently admits its current model declaration.
  const mimeTypes =
    entry.profile.provider === 'opencode'
      ? [...NATIVE_IMAGE_MIME_TYPES, ...NATIVE_VIDEO_MIME_TYPES]
      : [
          ...(capability.supportsImages ? capability.supportedImageMimeTypes : []),
          ...(capability.supportsFiles ? capability.supportedFileMimeTypes : []),
          ...(capability.supportsVideo ? capability.supportedVideoMimeTypes : []),
        ];
  const store = new AttachmentArtifactStore(
    options.storageRoot,
    entry.team.definition.binding,
    new TeamOwnerStore(options.storageRoot, entry.delivery.teamName)
  );
  function projectClaimed(input: Input): Input {
    options.assertCurrent();
    const { record, attached } = options.readRuntime(entry.binding);
    const claimed = record?.inputs.find(
      (item) =>
        item.intent.inputId === input.inputId &&
        item.operationRef === input.operationRef &&
        item.phase === 'claimed'
    );
    if (
      !record ||
      !attached ||
      !claimed ||
      !target ||
      input.content !== (claimed.preparation?.prefix ?? '') + claimed.intent.content ||
      JSON.stringify(input.attachments ?? []) !==
        JSON.stringify(claimed.intent.attachments ?? []) ||
      !entry.team.owner.authorizeDeliveryIntent(claimed.intent)
    )
      throw new TeamOwnerError('hold');
    const refs = input.attachments ?? [];
    if (!refs.length) return input;
    // Verify the entire original owner/purpose batch before projecting either transport.
    const metadata = store.metadata(refs, { kind: 'message', member: target.name });
    const native: NonNullable<Input['attachments']>[number][] = [];
    const references: { filename: string; filePath: string; size: number; sha256: string }[] = [];
    refs.forEach((reference, index) => {
      const artifact = store.resolve(reference);
      const route = getMessageAttachmentRoute(
        {
          providerId: entry.profile.provider === 'claude' ? 'anthropic' : entry.profile.provider,
          isLeadRecipient: target.role === 'lead',
          // Current D Codex SPI supports image refs only, never native text file input.
          nativeInboxTextAttachmentsSupported: false,
        },
        reference.mimeType,
        reference.mimeType !== 'text/plain' || isStrictUtf8(artifact.bytes)
      );
      if (route === 'native') native.push(reference);
      else
        references.push({
          filename: metadata[index]!.filename,
          filePath: artifact.nativePath,
          size: reference.byteLength,
          sha256: reference.digest,
        });
    });
    options.assertCurrent();
    return {
      inputId: input.inputId,
      operationRef: input.operationRef,
      content: decorateFileReferences(input.content, references, agentBlocks.wrapAgentBlock),
      ...(native.length ? { attachments: native } : {}),
    };
  }
  const port: NonNullable<MemberProviderContext['attachments']> = {
    model,
    revision: createHash('sha256')
      .update(
        JSON.stringify({
          version: 1,
          provider: entry.profile.provider,
          model,
          mimeTypes,
          maxImages: capability.maxImages,
          maxFiles: capability.maxFiles,
          maxVideos: capability.maxVideos,
          maxBytesPerImage: capability.maxBytesPerImage,
          maxBytesPerFile: capability.maxBytesPerFile,
          maxBytesPerVideo: capability.maxBytesPerVideo,
          maxBytesTotal: capability.maxBytesTotal,
        })
      )
      .digest('hex'),
    mimeTypes,
    async resolve(request, signal) {
      signal.throwIfAborted();
      options.assertCurrent();
      const { record, attached } = options.readRuntime(entry.binding);
      const input = record?.inputs.find(
        (item) =>
          item.intent.inputId === request.inputId &&
          item.operationRef === request.operationRef &&
          item.phase === 'claimed'
      );
      if (
        !attached ||
        !record ||
        record.sessionRef !== request.sessionRef ||
        !input ||
        request.trustedBinding !==
          `${entry.binding.backendId}/${entry.binding.teamId}/${entry.binding.runId}/${entry.binding.memberId}`
      )
        return undefined;
      return entry.team.owner.withLaunchAuthority(entry.profile.principalId, 'read', () => {
        signal.throwIfAborted();
        options.assertCurrent();
        if (!entry.team.owner.authorizeDeliveryIntent(input.intent))
          throw new TeamOwnerError('hold');
        const projected = projectClaimed({
          inputId: input.intent.inputId,
          operationRef: input.operationRef,
          content: (input.preparation?.prefix ?? '') + input.intent.content,
          ...(input.intent.attachments?.length ? { attachments: input.intent.attachments } : {}),
        });
        if (
          request.fingerprint !== fingerprint(projected) ||
          !projected.attachments?.some(
            (ref) => JSON.stringify(ref) === JSON.stringify(request.reference)
          )
        )
          return undefined;
        const artifact = store.resolve(request.reference);
        options.assertCurrent();
        signal.throwIfAborted();
        return { binding: request, ...artifact };
      });
    },
  };
  return {
    port,
    prepareInput(input) {
      if (!input.attachments?.length) return input;
      return entry.team.owner.withLaunchAuthority(entry.profile.principalId, 'read', () =>
        projectClaimed(input)
      );
    },
  };
}
