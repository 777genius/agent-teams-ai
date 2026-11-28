import { createRequire } from 'node:module';
import { AttachmentArtifactStore } from '../attachments/AttachmentArtifactStore.js';
import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { decorateFileReferences, getMessageAttachmentRoute, isStrictUtf8 } from '../attachments/portable.js';
import { TeamOwnerError } from '../team/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import type { Input } from '@agent-teams/provider-session-contracts';
import type { MemberEntry } from './MemberEntry.js';

const { agentBlocks } = createRequire(import.meta.url)('agent-teams-controller') as {
  agentBlocks: { wrapAgentBlock(text: string): string };
};

/** Shared original-profile identity, including the captured selected configuration when present. */
export function isCapturedMemberInputProfile(entry: MemberEntry): boolean {
  const baseDigest = runtimeDigest(entry.baseProfile);
  return runtimeDigest(entry.profile) === (entry.selection?.configurationDigest ?? baseDigest) &&
    (!entry.selection || entry.selection.baseConfigurationDigest === baseDigest);
}

/** Exact captured attachment projection, shared before admission and after the original input claim. */
export function projectMemberInput(options: {
  entry: MemberEntry;
  storageRoot: string;
  input: { content: string; attachments?: readonly NonNullable<Input['attachments']>[number][] };
  assertCurrent(): void;
}): Pick<Input, 'content' | 'attachments'> {
  const { entry, input } = options;
  options.assertCurrent();
  if (!isCapturedMemberInputProfile(entry)) throw new TeamOwnerError('hold');
  const refs = input.attachments ?? [];
  if (!refs.length) return { content: input.content,
    ...(input.attachments === undefined ? {} : { attachments: [...input.attachments] }) };
  const target = entry.team.definition.members.find(member => member.memberId === entry.binding.memberId);
  if (!target) throw new TeamOwnerError('hold');
  const store = new AttachmentArtifactStore(options.storageRoot, entry.team.definition.binding,
    new TeamOwnerStore(options.storageRoot, entry.delivery.teamName, { createNamespace: false }));
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
        ...(entry.profile.provider === 'opencode' && entry.profile.nativeGeneration === 'v2'
          ? { nativeMediaTransport: 'opencode-2.1.4-native-media-v1' as const } : {}),
      },
      reference.mimeType,
      reference.mimeType !== 'text/plain' || isStrictUtf8(artifact.bytes)
    );
    if (route === 'native') native.push(reference);
    else references.push({
      filename: metadata[index]!.filename, filePath: artifact.nativePath,
      size: reference.byteLength, sha256: reference.digest,
    });
  });
  options.assertCurrent();
  return {
    content: decorateFileReferences(input.content, references, agentBlocks.wrapAgentBlock),
    ...(native.length ? { attachments: native } : {}),
  };
}
