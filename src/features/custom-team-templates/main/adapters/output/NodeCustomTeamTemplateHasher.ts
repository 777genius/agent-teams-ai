import { createHash } from 'node:crypto';

import type {
  CustomTeamTemplateHasher,
  CustomTeamTemplateIdentityInput,
} from '../../../core/application/ports';

/**
 * SHA-256 hashing for template content and identity, mirroring the existing
 * main-process hashing adapter convention (`sha256:` prefixed hex digests).
 *
 * Digests are always computed here, in trusted main-process code, from the
 * validated canonical projection. The persistence layer only stores the content
 * digest and compares it with the value it previously stored, so the algorithm
 * stays swappable.
 */
export class NodeCustomTeamTemplateHasher implements CustomTeamTemplateHasher {
  hashCanonicalContent(canonicalContent: string): string {
    return `sha256:${createHash('sha256').update(canonicalContent, 'utf8').digest('hex')}`;
  }

  /**
   * Derives the stable template id from the immutable persisted identity.
   *
   * The tuple is serialized as a JSON array so no delimiter ambiguity can make
   * two different identities agree. Including the normalized name key and the
   * description is what keeps two templates with identical team content from
   * sharing one id, while still making a retry of the same save idempotent.
   */
  deriveTemplateId(identity: CustomTeamTemplateIdentityInput): string {
    const digest = createHash('sha256')
      .update(
        JSON.stringify([identity.contentHash, identity.nameKey, identity.description ?? null]),
        'utf8'
      )
      .digest('hex');
    return `tmpl-${digest.slice(0, 32)}`;
  }
}
