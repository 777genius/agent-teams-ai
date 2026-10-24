import { createHash } from 'node:crypto';
import { AttachmentArtifactStore } from '../attachments/AttachmentArtifactStore.js';
import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { resolveAgentAttachmentCapability } from '../attachments/capabilities.js';
import { TeamOwnerError } from '../team/contracts.js';
import type { MemberProviderContext } from '../adapters/providers/MemberProvider.js';
import type { MemberEntry } from './MemberEntry.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';

/** D owns native formatting; this private port resolves only the exact claimed selected-Team input. */
export function createMemberAttachmentPort(options: {
  entry: MemberEntry;
  storageRoot: string;
  assertCurrent(): void;
  readRuntime: RuntimeOwner['readCapturedSession'];
}): NonNullable<MemberProviderContext['attachments']> {
  const { entry } = options;
  const target = entry.team.definition.members.find(
    (member) => member.memberId === entry.binding.memberId
  );
  const capability = resolveAgentAttachmentCapability({
    providerId: entry.profile.provider === 'claude' ? 'anthropic' : entry.profile.provider,
    model: entry.profile.model,
  });
  const mimeTypes =
    target?.role === 'lead' || entry.profile.provider === 'opencode'
      ? [
          ...(capability.supportsImages ? capability.supportedImageMimeTypes : []),
          ...(capability.supportsFiles ? capability.supportedFileMimeTypes : []),
          ...(capability.supportsVideo ? capability.supportedVideoMimeTypes : []),
        ]
      : [];
  const store = new AttachmentArtifactStore(
    options.storageRoot,
    entry.team.definition.binding,
    new TeamOwnerStore(options.storageRoot, entry.delivery.teamName)
  );
  return {
    model: entry.profile.model,
    revision: createHash('sha256')
      .update(
        JSON.stringify({
          version: 1,
          provider: entry.profile.provider,
          model: entry.profile.model,
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
      const content = (input.preparation?.prefix ?? '') + input.intent.content;
      const refs = input.intent.attachments ?? [];
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            content,
            refs.map((ref) => [ref.artifactId, ref.mimeType, ref.byteLength, ref.digest]),
          ])
        )
        .digest('hex');
      if (
        request.fingerprint !== fingerprint ||
        !refs.some((ref) => JSON.stringify(ref) === JSON.stringify(request.reference))
      )
        return undefined;
      return entry.team.owner.withLaunchAuthority(entry.profile.principalId, 'read', () => {
        signal.throwIfAborted();
        options.assertCurrent();
        if (!entry.team.owner.authorizeDeliveryIntent(input.intent))
          throw new TeamOwnerError('hold');
        const artifact = store.resolve(request.reference);
        options.assertCurrent();
        signal.throwIfAborted();
        return { binding: request, ...artifact };
      });
    },
  };
}
